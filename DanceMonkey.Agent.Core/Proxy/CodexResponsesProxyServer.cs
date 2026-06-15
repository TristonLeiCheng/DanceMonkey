using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace DanceMonkey.Agent.Core.Proxy;

public sealed class CodexResponsesProxyServer : IDisposable
{
    private const string ServerHeader = "DanceMonkey-CodexProxy/1.0";
    private const int HeaderReadLimit = 64 * 1024;
    private const int BodyReadLimit = 64 * 1024 * 1024;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly CodexProxyOptions _options;
    private readonly HttpClient _http;
    private readonly string _chatEndpoint;
    private TcpListener? _listener;

    public CodexResponsesProxyServer(CodexProxyOptions options)
    {
        _options = options;
        _chatEndpoint = ResolveChatCompletionsEndpoint(options.ChatCompletionsEndpoint);
        _http = new HttpClient { Timeout = options.UpstreamTimeout };
    }

    public string LocalBaseUrl => $"http://{_options.Host}:{_options.Port}";
    public string ResponsesUrl => $"{LocalBaseUrl}/v1/responses";
    public string ChatEndpoint => _chatEndpoint;

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (_listener != null)
            throw new InvalidOperationException("Codex proxy is already running.");

        _listener = new TcpListener(ParseBindAddress(_options.Host), _options.Port);
        _listener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
        _listener.Start();
        _options.Log?.Invoke($"Listening on {ResponsesUrl}");
        _options.Log?.Invoke($"Responses -> Chat upstream: {_chatEndpoint}");

        try
        {
            using var registration = cancellationToken.Register(Stop);
            while (!cancellationToken.IsCancellationRequested)
            {
                TcpClient client;
                try
                {
                    client = await _listener.AcceptTcpClientAsync(cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (ObjectDisposedException)
                {
                    break;
                }
                catch (SocketException) when (cancellationToken.IsCancellationRequested)
                {
                    break;
                }

                _ = Task.Run(() => HandleConnectionAsync(client, cancellationToken), CancellationToken.None);
            }
        }
        finally
        {
            Stop();
        }
    }

    public void Stop()
    {
        try { _listener?.Stop(); } catch (SocketException ex) { _options.Log?.Invoke($"Stop failed: {ex.Message}"); }
        _listener = null;
    }

    public void Dispose()
    {
        Stop();
        _http.Dispose();
    }

    private async Task HandleConnectionAsync(TcpClient client, CancellationToken serverToken)
    {
        using var _ = client;
        client.NoDelay = true;

        using var stream = client.GetStream();
        HttpRequestData? request = null;
        try
        {
            request = await ReadRequestAsync(stream, serverToken).ConfigureAwait(false);
            if (request == null)
                return;

            await DispatchAsync(stream, request, serverToken).ConfigureAwait(false);
        }
        catch (ProxyHttpException ex)
        {
            await WriteJsonAsync(stream, ex.StatusCode, new JsonObject { ["error"] = ex.Message }, serverToken)
                .ConfigureAwait(false);
        }
        catch (UpstreamHttpException ex)
        {
            await WriteRawAsync(stream, ex.StatusCode, ex.ContentType, ex.Body, serverToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (serverToken.IsCancellationRequested)
        {
            // Server is stopping.
        }
        catch (Exception ex)
        {
            _options.Log?.Invoke($"Request failed{(request == null ? "" : $" {request.Method} {request.Path}")}: {ex.Message}");
            await WriteJsonAsync(stream, 500, new JsonObject { ["error"] = ex.Message }, CancellationToken.None)
                .ConfigureAwait(false);
        }
    }

    private async Task DispatchAsync(NetworkStream stream, HttpRequestData request, CancellationToken ct)
    {
        if (request.Method.Equals("GET", StringComparison.OrdinalIgnoreCase) &&
            request.Path.Equals("/health", StringComparison.OrdinalIgnoreCase))
        {
            await WriteJsonAsync(stream, 200, new JsonObject
            {
                ["ok"] = true,
                ["responses_url"] = ResponsesUrl,
                ["chat_endpoint"] = _chatEndpoint,
            }, ct).ConfigureAwait(false);
            return;
        }

        if (request.Method.Equals("GET", StringComparison.OrdinalIgnoreCase) &&
            request.Path.Equals("/v1/models", StringComparison.OrdinalIgnoreCase))
        {
            await WriteJsonAsync(stream, 200, new JsonObject
            {
                ["object"] = "list",
                ["data"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["id"] = string.IsNullOrWhiteSpace(_options.DefaultModel) ? "gpt-4o-mini" : _options.DefaultModel,
                        ["object"] = "model",
                        ["created"] = 0,
                        ["owned_by"] = "DanceMonkey",
                    }
                },
            }, ct).ConfigureAwait(false);
            return;
        }

        var normalizedPath = request.Path.TrimEnd('/');
        if (request.Method.Equals("POST", StringComparison.OrdinalIgnoreCase) &&
            normalizedPath.Equals("/v1/responses", StringComparison.OrdinalIgnoreCase))
        {
            await HandleResponsesAsync(stream, request, ct).ConfigureAwait(false);
            return;
        }

        await WriteJsonAsync(stream, 404, new JsonObject { ["error"] = "not found" }, ct).ConfigureAwait(false);
    }

    private async Task HandleResponsesAsync(NetworkStream stream, HttpRequestData request, CancellationToken ct)
    {
        var responsesRequest = ParseJsonBody(request.Body);
        RejectUnsupportedDataImages(responsesRequest);

        var requestedStream = GetBool(responsesRequest, "stream");
        var chatRequest = ResponsesRequestToChatCompletions(responsesRequest);
        chatRequest["stream"] = false;

        var upstream = await CallChatCompletionsAsync(chatRequest, ResolveApiKey(request.Headers), ct).ConfigureAwait(false);
        var response = ChatCompletionsResponseToResponses(upstream, responsesRequest);

        if (requestedStream)
            await WriteSyntheticResponsesStreamAsync(stream, response, ct).ConfigureAwait(false);
        else
            await WriteJsonAsync(stream, 200, response, ct).ConfigureAwait(false);
    }

    private JsonObject ResponsesRequestToChatCompletions(JsonObject request)
    {
        var chat = new JsonObject
        {
            ["model"] = GetString(request, "model") ?? FallbackModel(),
            ["messages"] = BuildChatMessages(request),
        };

        CopyIfPresent(request, chat, "temperature");
        CopyIfPresent(request, chat, "top_p");
        CopyIfPresent(request, chat, "presence_penalty");
        CopyIfPresent(request, chat, "frequency_penalty");
        CopyIfPresent(request, chat, "seed");
        CopyIfPresent(request, chat, "stop");
        CopyIfPresent(request, chat, "user");
        CopyRenamedIfPresent(request, chat, "max_output_tokens", "max_tokens");
        CopyIfPresent(request, chat, "max_tokens");

        if (request.TryGetPropertyValue("tools", out var toolsNode) && toolsNode is JsonArray tools)
        {
            var mapped = MapResponsesToolsToChatTools(tools);
            if (mapped.Count > 0)
                chat["tools"] = mapped;
        }

        if (request.TryGetPropertyValue("tool_choice", out var toolChoice))
        {
            var mapped = MapResponsesToolChoiceToChatToolChoice(toolChoice);
            if (mapped != null)
                chat["tool_choice"] = mapped;
        }

        CopyIfPresent(request, chat, "parallel_tool_calls");
        return chat;
    }

    private JsonArray BuildChatMessages(JsonObject request)
    {
        var messages = new JsonArray();
        var instructions = GetString(request, "instructions");
        if (!string.IsNullOrWhiteSpace(instructions))
            messages.Add(new JsonObject { ["role"] = "system", ["content"] = instructions });

        if (!request.TryGetPropertyValue("input", out var input) || input == null)
        {
            messages.Add(new JsonObject { ["role"] = "user", ["content"] = "" });
            return messages;
        }

        if (TryGetString(input, out var inputText))
        {
            messages.Add(new JsonObject { ["role"] = "user", ["content"] = inputText });
            return messages;
        }

        if (input is not JsonArray items)
        {
            messages.Add(new JsonObject { ["role"] = "user", ["content"] = input.ToJsonString(JsonOptions) });
            return messages;
        }

        var pendingFunctionCalls = new List<JsonObject>();
        foreach (var item in items)
            AddResponsesInputItem(messages, item, pendingFunctionCalls);

        CoalescePendingFunctionCalls(messages, pendingFunctionCalls);

        if (messages.Count == 0)
            messages.Add(new JsonObject { ["role"] = "user", ["content"] = "" });

        return messages;
    }

    private static void AddResponsesInputItem(JsonArray messages, JsonNode? item, List<JsonObject> pendingFunctionCalls)
    {
        if (item == null)
            return;

        if (TryGetString(item, out var textItem))
        {
            CoalescePendingFunctionCalls(messages, pendingFunctionCalls);
            messages.Add(new JsonObject { ["role"] = "user", ["content"] = textItem });
            return;
        }

        if (item is not JsonObject obj)
        {
            CoalescePendingFunctionCalls(messages, pendingFunctionCalls);
            messages.Add(new JsonObject { ["role"] = "user", ["content"] = item.ToJsonString(JsonOptions) });
            return;
        }

        var type = GetString(obj, "type");
        if (type == "reasoning")
            return;

        if (type == "function_call")
        {
            pendingFunctionCalls.Add(obj);
            return;
        }

        if (type == "function_call_output")
        {
            CoalescePendingFunctionCalls(messages, pendingFunctionCalls);
            messages.Add(new JsonObject
            {
                ["role"] = "tool",
                ["tool_call_id"] = ResolveToolCallId(obj, preferCallIdOnly: true),
                ["content"] = ContentNodeToString(obj["output"]),
            });
            return;
        }

        CoalescePendingFunctionCalls(messages, pendingFunctionCalls);

        if (type == "input_text")
        {
            messages.Add(new JsonObject { ["role"] = "user", ["content"] = GetString(obj, "text") ?? "" });
            return;
        }

        if (type == "message" &&
            obj.TryGetPropertyValue("tool_calls", out var embeddedToolCalls) &&
            embeddedToolCalls is JsonArray toolCalls &&
            toolCalls.Count > 0)
        {
            messages.Add(BuildAssistantToolCallsMessageFromChatToolCalls(toolCalls));
            return;
        }

        var role = NormalizeChatRole(GetString(obj, "role") ?? (type == "message" ? "user" : "user"));
        messages.Add(new JsonObject
        {
            ["role"] = role,
            ["content"] = ResponsesContentToChatContent(obj["content"], role),
        });
    }

    private static void CoalescePendingFunctionCalls(JsonArray messages, List<JsonObject> pending)
    {
        if (pending.Count == 0)
            return;

        messages.Add(BuildAssistantToolCallsMessage(pending));
        pending.Clear();
    }

    private static JsonObject BuildAssistantToolCallsMessage(IReadOnlyList<JsonObject> functionCalls)
    {
        var toolCalls = new JsonArray();
        foreach (var functionCall in functionCalls)
        {
            var callId = ResolveToolCallId(functionCall, preferCallIdOnly: false);
            toolCalls.Add(new JsonObject
            {
                ["id"] = callId,
                ["type"] = "function",
                ["function"] = new JsonObject
                {
                    ["name"] = GetString(functionCall, "name") ?? "tool",
                    ["arguments"] = GetString(functionCall, "arguments") ?? "{}",
                },
            });
        }

        return new JsonObject
        {
            ["role"] = "assistant",
            ["content"] = null,
            ["tool_calls"] = toolCalls,
        };
    }

    private static JsonObject BuildAssistantToolCallsMessageFromChatToolCalls(JsonArray toolCalls)
    {
        var normalized = new JsonArray();
        foreach (var toolCall in toolCalls)
        {
            if (toolCall is JsonObject toolCallObj)
                normalized.Add(toolCallObj.DeepClone());
        }

        return new JsonObject
        {
            ["role"] = "assistant",
            ["content"] = null,
            ["tool_calls"] = normalized,
        };
    }

    private static string ResolveToolCallId(JsonObject obj, bool preferCallIdOnly)
    {
        var callId = GetString(obj, "call_id");
        if (!string.IsNullOrWhiteSpace(callId))
            return callId.Trim();

        if (preferCallIdOnly)
            return GetString(obj, "id") ?? $"call_{Guid.NewGuid():N}";

        var id = GetString(obj, "id");
        return !string.IsNullOrWhiteSpace(id) ? id.Trim() : $"call_{Guid.NewGuid():N}";
    }

    private static JsonNode ResponsesContentToChatContent(JsonNode? content, string role)
    {
        if (content == null)
            return JsonValue.Create("")!;

        if (TryGetString(content, out var text))
            return JsonValue.Create(text)!;

        if (content is not JsonArray parts)
            return JsonValue.Create(content.ToJsonString(JsonOptions))!;

        var chatParts = new JsonArray();
        var textOnly = true;
        var textBuilder = new StringBuilder();

        foreach (var part in parts)
        {
            if (part == null)
                continue;

            if (TryGetString(part, out var rawPartText))
            {
                chatParts.Add(new JsonObject { ["type"] = "text", ["text"] = rawPartText });
                textBuilder.Append(rawPartText);
                continue;
            }

            if (part is not JsonObject partObj)
            {
                var serialized = part.ToJsonString(JsonOptions);
                chatParts.Add(new JsonObject { ["type"] = "text", ["text"] = serialized });
                textBuilder.Append(serialized);
                continue;
            }

            var partType = GetString(partObj, "type");
            if (partType is "input_text" or "output_text" or "text")
            {
                var partText = GetString(partObj, "text") ?? "";
                chatParts.Add(new JsonObject { ["type"] = "text", ["text"] = partText });
                textBuilder.Append(partText);
                continue;
            }

            if (partType == "input_image")
            {
                var imageUrl = partObj["image_url"] ?? partObj["url"] ?? partObj["file_id"];
                JsonObject imagePayload;
                if (imageUrl is JsonObject imageObj)
                    imagePayload = CloneObject(imageObj);
                else
                    imagePayload = new JsonObject { ["url"] = NodeToString(imageUrl) ?? "" };

                if (partObj.TryGetPropertyValue("detail", out var detail) && detail != null &&
                    !imagePayload.ContainsKey("detail"))
                    imagePayload["detail"] = detail.DeepClone();

                chatParts.Add(new JsonObject { ["type"] = "image_url", ["image_url"] = imagePayload });
                textOnly = false;
                continue;
            }

            if (partType == "image_url")
            {
                var imageUrl = partObj["image_url"];
                if (TryGetString(imageUrl, out var imageUrlText))
                {
                    chatParts.Add(new JsonObject
                    {
                        ["type"] = "image_url",
                        ["image_url"] = new JsonObject { ["url"] = imageUrlText },
                    });
                }
                else
                {
                    chatParts.Add(CloneObject(partObj));
                }
                textOnly = false;
                continue;
            }

            var fallback = partObj.ToJsonString(JsonOptions);
            chatParts.Add(new JsonObject { ["type"] = "text", ["text"] = fallback });
            textBuilder.Append(fallback);
        }

        if (textOnly || role != "user")
            return JsonValue.Create(textBuilder.ToString())!;

        return chatParts;
    }

    private static JsonArray MapResponsesToolsToChatTools(JsonArray responsesTools)
    {
        var chatTools = new JsonArray();
        foreach (var tool in responsesTools)
        {
            if (tool is not JsonObject toolObj)
                continue;

            if (toolObj.TryGetPropertyValue("function", out var fnNode) && fnNode is JsonObject)
            {
                chatTools.Add(CloneObject(toolObj));
                continue;
            }

            var type = GetString(toolObj, "type");
            if (type != "function")
                continue;

            var function = new JsonObject
            {
                ["name"] = GetString(toolObj, "name") ?? "tool",
            };

            CopyIfPresent(toolObj, function, "description");
            CopyIfPresent(toolObj, function, "parameters");
            CopyIfPresent(toolObj, function, "strict");

            chatTools.Add(new JsonObject
            {
                ["type"] = "function",
                ["function"] = function,
            });
        }
        return chatTools;
    }

    private static JsonNode? MapResponsesToolChoiceToChatToolChoice(JsonNode? toolChoice)
    {
        if (toolChoice == null)
            return null;

        if (TryGetString(toolChoice, out var choiceText))
            return JsonValue.Create(choiceText);

        if (toolChoice is not JsonObject obj)
            return toolChoice.DeepClone();

        if (GetString(obj, "type") == "function" && !obj.ContainsKey("function"))
        {
            return new JsonObject
            {
                ["type"] = "function",
                ["function"] = new JsonObject { ["name"] = GetString(obj, "name") ?? "" },
            };
        }

        return obj.DeepClone();
    }

    private async Task<JsonObject> CallChatCompletionsAsync(JsonObject chatRequest, string apiKey, CancellationToken ct)
    {
        var body = chatRequest.ToJsonString(JsonOptions);
        using var request = new HttpRequestMessage(HttpMethod.Post, _chatEndpoint);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);

        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        var responseBody = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            var contentType = response.Content.Headers.ContentType?.ToString() ?? "application/json; charset=utf-8";
            throw new UpstreamHttpException((int)response.StatusCode, contentType, Encoding.UTF8.GetBytes(responseBody));
        }

        var decoded = JsonNode.Parse(responseBody) as JsonObject;
        if (decoded == null)
            throw new ProxyHttpException(502, "Chat Completions upstream returned a non-object JSON payload.");

        return decoded;
    }

    private JsonObject ChatCompletionsResponseToResponses(JsonObject chatResponse, JsonObject responsesRequest)
    {
        var responseId = $"resp_{Guid.NewGuid():N}";
        var created = GetLong(chatResponse, "created") ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var model = GetString(chatResponse, "model") ?? GetString(responsesRequest, "model") ?? FallbackModel();
        var output = new JsonArray();
        var outputText = new StringBuilder();

        if (chatResponse.TryGetPropertyValue("choices", out var choicesNode) && choicesNode is JsonArray choices)
        {
            foreach (var choice in choices)
            {
                if (choice is not JsonObject choiceObj ||
                    !choiceObj.TryGetPropertyValue("message", out var messageNode) ||
                    messageNode is not JsonObject message)
                    continue;

                AppendMessageOutputItems(output, outputText, message);
            }
        }

        if (output.Count == 0)
        {
            var fallbackText = GetString(chatResponse, "content") ?? GetString(chatResponse, "message") ?? "";
            output.Add(BuildOutputMessageItem(fallbackText));
            outputText.Append(fallbackText);
        }

        var response = new JsonObject
        {
            ["id"] = responseId,
            ["object"] = "response",
            ["created_at"] = created,
            ["status"] = "completed",
            ["model"] = model,
            ["output"] = output,
            ["output_text"] = outputText.ToString(),
        };

        if (chatResponse.TryGetPropertyValue("usage", out var usageNode) && usageNode is JsonObject usage)
            response["usage"] = MapChatUsageToResponsesUsage(usage);

        return response;
    }

    private static void AppendMessageOutputItems(JsonArray output, StringBuilder outputText, JsonObject message)
    {
        var text = ExtractChatMessageText(message["content"]);
        if (!string.IsNullOrEmpty(text))
        {
            output.Add(BuildOutputMessageItem(text));
            outputText.Append(text);
        }

        if (message.TryGetPropertyValue("tool_calls", out var toolCallsNode) && toolCallsNode is JsonArray toolCalls)
        {
            foreach (var toolCall in toolCalls)
            {
                if (toolCall is JsonObject toolCallObj)
                    output.Add(BuildFunctionCallOutputItem(toolCallObj));
            }
        }

        if (message.TryGetPropertyValue("function_call", out var functionCallNode) &&
            functionCallNode is JsonObject functionCall)
        {
            output.Add(new JsonObject
            {
                ["id"] = $"fc_{Guid.NewGuid():N}",
                ["type"] = "function_call",
                ["status"] = "completed",
                ["call_id"] = $"call_{Guid.NewGuid():N}",
                ["name"] = GetString(functionCall, "name") ?? "tool",
                ["arguments"] = GetString(functionCall, "arguments") ?? "{}",
            });
        }
    }

    private static JsonObject BuildOutputMessageItem(string text) => new()
    {
        ["id"] = $"msg_{Guid.NewGuid():N}",
        ["type"] = "message",
        ["status"] = "completed",
        ["role"] = "assistant",
        ["content"] = new JsonArray
        {
            new JsonObject
            {
                ["type"] = "output_text",
                ["text"] = text,
                ["annotations"] = new JsonArray(),
            }
        },
    };

    private static JsonObject BuildFunctionCallOutputItem(JsonObject toolCall)
    {
        var function = toolCall["function"] as JsonObject;
        var callId = GetString(toolCall, "id") ?? $"call_{Guid.NewGuid():N}";
        return new JsonObject
        {
            ["id"] = callId.StartsWith("fc_", StringComparison.Ordinal) ? callId : $"fc_{Guid.NewGuid():N}",
            ["type"] = "function_call",
            ["status"] = "completed",
            ["call_id"] = callId,
            ["name"] = GetString(function, "name") ?? "tool",
            ["arguments"] = GetString(function, "arguments") ?? "{}",
        };
    }

    private static JsonObject MapChatUsageToResponsesUsage(JsonObject usage) => new()
    {
        ["input_tokens"] = GetLong(usage, "prompt_tokens") ?? 0,
        ["output_tokens"] = GetLong(usage, "completion_tokens") ?? 0,
        ["total_tokens"] = GetLong(usage, "total_tokens") ?? 0,
    };

    private async Task WriteSyntheticResponsesStreamAsync(NetworkStream stream, JsonObject completed, CancellationToken ct)
    {
        await WriteHeadersAsync(stream, 200, "OK", "text/event-stream; charset=utf-8", null, ct).ConfigureAwait(false);

        var created = CloneObject(completed);
        created["status"] = "in_progress";
        created["output"] = new JsonArray();
        created["output_text"] = "";

        await WriteSseAsync(stream, new JsonObject { ["type"] = "response.created", ["response"] = created }, ct)
            .ConfigureAwait(false);

        if (completed["output"] is JsonArray output)
        {
            for (var i = 0; i < output.Count; i++)
            {
                if (output[i] is JsonObject item)
                    await EmitOutputItemEventsAsync(stream, completed, item, i, ct).ConfigureAwait(false);
            }
        }

        await WriteSseAsync(stream, new JsonObject { ["type"] = "response.completed", ["response"] = completed }, ct)
            .ConfigureAwait(false);
        await WriteRawEventLineAsync(stream, "data: [DONE]\n\n", ct).ConfigureAwait(false);
    }

    private static async Task EmitOutputItemEventsAsync(
        NetworkStream stream,
        JsonObject response,
        JsonObject item,
        int outputIndex,
        CancellationToken ct)
    {
        var itemStarted = CloneObject(item);
        if (GetString(item, "type") == "message")
            itemStarted["content"] = new JsonArray();

        await WriteSseAsync(stream, new JsonObject
        {
            ["type"] = "response.output_item.added",
            ["response"] = response.DeepClone(),
            ["output_index"] = outputIndex,
            ["item"] = itemStarted,
        }, ct).ConfigureAwait(false);

        if (GetString(item, "type") == "message" && item["content"] is JsonArray content)
        {
            for (var contentIndex = 0; contentIndex < content.Count; contentIndex++)
            {
                if (content[contentIndex] is not JsonObject part)
                    continue;

                var partStarted = new JsonObject
                {
                    ["type"] = GetString(part, "type") ?? "output_text",
                    ["text"] = "",
                };

                await WriteSseAsync(stream, new JsonObject
                {
                    ["type"] = "response.content_part.added",
                    ["response"] = response.DeepClone(),
                    ["output_index"] = outputIndex,
                    ["content_index"] = contentIndex,
                    ["part"] = partStarted,
                }, ct).ConfigureAwait(false);

                var text = GetString(part, "text") ?? "";
                if (!string.IsNullOrEmpty(text))
                {
                    await WriteSseAsync(stream, new JsonObject
                    {
                        ["type"] = "response.output_text.delta",
                        ["response"] = response.DeepClone(),
                        ["output_index"] = outputIndex,
                        ["content_index"] = contentIndex,
                        ["delta"] = text,
                    }, ct).ConfigureAwait(false);

                    await WriteSseAsync(stream, new JsonObject
                    {
                        ["type"] = "response.output_text.done",
                        ["response"] = response.DeepClone(),
                        ["output_index"] = outputIndex,
                        ["content_index"] = contentIndex,
                        ["text"] = text,
                    }, ct).ConfigureAwait(false);
                }

                await WriteSseAsync(stream, new JsonObject
                {
                    ["type"] = "response.content_part.done",
                    ["response"] = response.DeepClone(),
                    ["output_index"] = outputIndex,
                    ["content_index"] = contentIndex,
                    ["part"] = part.DeepClone(),
                }, ct).ConfigureAwait(false);
            }
        }
        else if (GetString(item, "type") == "function_call")
        {
            var arguments = GetString(item, "arguments") ?? "{}";
            await WriteSseAsync(stream, new JsonObject
            {
                ["type"] = "response.function_call_arguments.delta",
                ["response"] = response.DeepClone(),
                ["output_index"] = outputIndex,
                ["delta"] = arguments,
            }, ct).ConfigureAwait(false);

            await WriteSseAsync(stream, new JsonObject
            {
                ["type"] = "response.function_call_arguments.done",
                ["response"] = response.DeepClone(),
                ["output_index"] = outputIndex,
                ["arguments"] = arguments,
            }, ct).ConfigureAwait(false);
        }

        await WriteSseAsync(stream, new JsonObject
        {
            ["type"] = "response.output_item.done",
            ["response"] = response.DeepClone(),
            ["output_index"] = outputIndex,
            ["item"] = item.DeepClone(),
        }, ct).ConfigureAwait(false);
    }

    private static async Task<HttpRequestData?> ReadRequestAsync(NetworkStream stream, CancellationToken ct)
    {
        var buffer = new byte[8192];
        await using var ms = new MemoryStream();
        var headerEnd = -1;

        while (ms.Length < HeaderReadLimit)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(0, buffer.Length), ct).ConfigureAwait(false);
            if (read <= 0)
                return null;

            ms.Write(buffer, 0, read);
            headerEnd = FindHeaderEnd(ms.GetBuffer(), (int)ms.Length);
            if (headerEnd >= 0)
                break;
        }

        if (headerEnd < 0)
            throw new ProxyHttpException(431, "request headers are too large or incomplete");

        var all = ms.ToArray();
        var headText = Encoding.ASCII.GetString(all, 0, headerEnd);
        var parsed = ParseHead(headText);
        var contentLength = ParseContentLength(parsed.Headers);
        if (contentLength > BodyReadLimit)
            throw new ProxyHttpException(413, "request body is too large");

        var body = new byte[contentLength];
        var alreadyRead = Math.Min(contentLength, all.Length - (headerEnd + 4));
        if (alreadyRead > 0)
            Buffer.BlockCopy(all, headerEnd + 4, body, 0, alreadyRead);

        var offset = alreadyRead;
        while (offset < contentLength)
        {
            var read = await stream.ReadAsync(body.AsMemory(offset, contentLength - offset), ct).ConfigureAwait(false);
            if (read <= 0)
                throw new ProxyHttpException(400, "request body ended before Content-Length bytes were received");
            offset += read;
        }

        return parsed with { Body = body };
    }

    private static int FindHeaderEnd(byte[] buffer, int length)
    {
        for (var i = 3; i < length; i++)
        {
            if (buffer[i - 3] == '\r' && buffer[i - 2] == '\n' &&
                buffer[i - 1] == '\r' && buffer[i] == '\n')
                return i - 3;
        }
        return -1;
    }

    private static HttpRequestData ParseHead(string headText)
    {
        var lines = headText.Split("\r\n", StringSplitOptions.None);
        if (lines.Length == 0)
            throw new ProxyHttpException(400, "missing request line");

        var requestLine = lines[0].Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (requestLine.Length < 2)
            throw new ProxyHttpException(400, "invalid request line");

        var rawPath = requestLine[1];
        var query = rawPath.IndexOf('?');
        var pathOnly = query >= 0 ? rawPath[..query] : rawPath;
        var path = Uri.UnescapeDataString(pathOnly);

        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 1; i < lines.Length; i++)
        {
            var line = lines[i];
            var colon = line.IndexOf(':');
            if (colon <= 0)
                continue;

            var name = line[..colon].Trim();
            if (name.Length == 0)
                continue;

            headers[name] = line[(colon + 1)..].Trim();
        }

        return new HttpRequestData(requestLine[0], path, headers, Array.Empty<byte>());
    }

    private static int ParseContentLength(IReadOnlyDictionary<string, string> headers)
    {
        if (!headers.TryGetValue("Content-Length", out var raw) || string.IsNullOrWhiteSpace(raw))
            return 0;

        if (!int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var value) || value < 0)
            throw new ProxyHttpException(400, "invalid Content-Length header");

        return value;
    }

    private static JsonObject ParseJsonBody(byte[] body)
    {
        if (body.Length == 0)
            throw new ProxyHttpException(400, "request body is empty");

        try
        {
            var node = JsonNode.Parse(Encoding.UTF8.GetString(body));
            return node as JsonObject ?? throw new ProxyHttpException(400, "request body must be a JSON object");
        }
        catch (JsonException ex)
        {
            throw new ProxyHttpException(400, $"invalid JSON request body: {ex.Message}");
        }
    }

    private string ResolveApiKey(IReadOnlyDictionary<string, string> headers)
    {
        if (!string.IsNullOrWhiteSpace(_options.ApiKey))
            return _options.ApiKey.Trim();

        if (headers.TryGetValue("Authorization", out var auth) &&
            auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            var token = auth["Bearer ".Length..].Trim();
            if (token.Length > 0)
                return token;
        }

        throw new ProxyHttpException(401, "missing upstream API key: configure DanceMonkey API key or send Authorization: Bearer ...");
    }

    private static async Task WriteJsonAsync(NetworkStream stream, int statusCode, JsonObject payload, CancellationToken ct)
    {
        var body = Encoding.UTF8.GetBytes(payload.ToJsonString(JsonOptions));
        await WriteRawAsync(stream, statusCode, "application/json; charset=utf-8", body, ct).ConfigureAwait(false);
    }

    private static async Task WriteRawAsync(
        NetworkStream stream,
        int statusCode,
        string contentType,
        byte[] body,
        CancellationToken ct)
    {
        await WriteHeadersAsync(stream, statusCode, ReasonPhrase(statusCode), contentType, body.Length, ct)
            .ConfigureAwait(false);
        if (body.Length > 0)
            await stream.WriteAsync(body, ct).ConfigureAwait(false);
    }

    private static async Task WriteHeadersAsync(
        NetworkStream stream,
        int statusCode,
        string reason,
        string contentType,
        int? contentLength,
        CancellationToken ct)
    {
        var sb = new StringBuilder();
        sb.Append("HTTP/1.1 ").Append(statusCode).Append(' ').Append(reason).Append("\r\n");
        sb.Append("Server: ").Append(ServerHeader).Append("\r\n");
        sb.Append("Content-Type: ").Append(contentType).Append("\r\n");
        sb.Append("Cache-Control: no-cache\r\n");
        sb.Append("Connection: close\r\n");
        if (contentLength.HasValue)
            sb.Append("Content-Length: ").Append(contentLength.Value.ToString(CultureInfo.InvariantCulture)).Append("\r\n");
        sb.Append("\r\n");

        var bytes = Encoding.ASCII.GetBytes(sb.ToString());
        await stream.WriteAsync(bytes, ct).ConfigureAwait(false);
    }

    private static async Task WriteSseAsync(NetworkStream stream, JsonObject payload, CancellationToken ct)
    {
        await WriteRawEventLineAsync(stream, $"data: {payload.ToJsonString(JsonOptions)}\n\n", ct).ConfigureAwait(false);
    }

    private static async Task WriteRawEventLineAsync(NetworkStream stream, string line, CancellationToken ct)
    {
        var bytes = Encoding.UTF8.GetBytes(line);
        await stream.WriteAsync(bytes, ct).ConfigureAwait(false);
        await stream.FlushAsync(ct).ConfigureAwait(false);
    }

    private static void RejectUnsupportedDataImages(JsonObject responsesRequest)
    {
        if (responsesRequest["input"] is not JsonArray items)
            return;

        foreach (var item in items.OfType<JsonObject>())
        {
            if (item["content"] is not JsonArray content)
                continue;

            foreach (var part in content.OfType<JsonObject>())
            {
                if (GetString(part, "type") != "input_image")
                    continue;

                var imageUrl = NodeToString(part["image_url"] ?? part["url"] ?? part["file_id"]);
                if (LooksLikeDataImageUrl(imageUrl))
                    throw new ProxyHttpException(
                        400,
                        "upstream chat supplier does not support data: image URLs; use an http(s) image_url or upload the image and reference a file_id");
            }
        }
    }

    private static bool LooksLikeDataImageUrl(string? value) =>
        value != null &&
        value.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase) &&
        value.Contains(";base64,", StringComparison.OrdinalIgnoreCase);

    private static string ResolveChatCompletionsEndpoint(string? configured)
    {
        if (string.IsNullOrWhiteSpace(configured))
            return "https://api.openai.com/v1/chat/completions";

        var url = configured.Trim();
        if (url.Contains("chat/completions", StringComparison.OrdinalIgnoreCase))
            return url;

        url = url.TrimEnd('/');
        string[] apiRoots = { "/api/v1", "/api/v2", "/api/v3", "/v1", "/v2", "/v3" };
        return apiRoots.Any(root => url.EndsWith(root, StringComparison.OrdinalIgnoreCase))
            ? url + "/chat/completions"
            : url;
    }

    private string FallbackModel() =>
        string.IsNullOrWhiteSpace(_options.DefaultModel) ? "gpt-4o-mini" : _options.DefaultModel.Trim();

    private static IPAddress ParseBindAddress(string host)
    {
        if (string.IsNullOrWhiteSpace(host) ||
            host.Equals("localhost", StringComparison.OrdinalIgnoreCase))
            return IPAddress.Loopback;

        return IPAddress.TryParse(host, out var ip) ? ip : IPAddress.Loopback;
    }

    private static string NormalizeChatRole(string role)
    {
        return role switch
        {
            "developer" => "system",
            "system" => "system",
            "assistant" => "assistant",
            "tool" => "tool",
            _ => "user",
        };
    }

    private static string ExtractChatMessageText(JsonNode? content)
    {
        if (content == null)
            return "";

        if (TryGetString(content, out var text))
            return text;

        if (content is not JsonArray parts)
            return content.ToJsonString(JsonOptions);

        var sb = new StringBuilder();
        foreach (var part in parts)
        {
            if (part is JsonObject obj)
                sb.Append(GetString(obj, "text") ?? GetString(obj, "content") ?? "");
            else if (TryGetString(part, out var partText))
                sb.Append(partText);
        }
        return sb.ToString();
    }

    private static string ContentNodeToString(JsonNode? node)
    {
        if (node == null)
            return "";

        if (TryGetString(node, out var text))
            return text;

        if (node is JsonArray parts)
        {
            var sb = new StringBuilder();
            foreach (var part in parts)
            {
                if (part is JsonObject obj)
                    sb.Append(GetString(obj, "text") ?? GetString(obj, "content") ?? obj.ToJsonString(JsonOptions));
                else if (TryGetString(part, out var partText))
                    sb.Append(partText);
                else if (part != null)
                    sb.Append(part.ToJsonString(JsonOptions));
            }
            return sb.ToString();
        }

        return node.ToJsonString(JsonOptions);
    }

    private static string? NodeToString(JsonNode? node)
    {
        if (node == null)
            return null;

        return TryGetString(node, out var text) ? text : node.ToJsonString(JsonOptions);
    }

    private static string? GetString(JsonObject? obj, string propertyName)
    {
        if (obj == null)
            return null;

        return obj.TryGetPropertyValue(propertyName, out var node) ? NodeToString(node) : null;
    }

    private static bool GetBool(JsonObject obj, string propertyName)
    {
        if (!obj.TryGetPropertyValue(propertyName, out var node) || node == null)
            return false;

        if (node is JsonValue value)
        {
            if (value.TryGetValue<bool>(out var boolValue))
                return boolValue;
            if (value.TryGetValue<string>(out var stringValue))
                return stringValue.Equals("true", StringComparison.OrdinalIgnoreCase);
        }

        return false;
    }

    private static long? GetLong(JsonObject? obj, string propertyName)
    {
        if (obj == null || !obj.TryGetPropertyValue(propertyName, out var node) || node == null)
            return null;

        if (node is JsonValue value)
        {
            if (value.TryGetValue<long>(out var longValue))
                return longValue;
            if (value.TryGetValue<int>(out var intValue))
                return intValue;
            if (value.TryGetValue<string>(out var stringValue) &&
                long.TryParse(stringValue, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
                return parsed;
        }

        return null;
    }

    private static bool TryGetString(JsonNode? node, out string text)
    {
        text = "";
        if (node is not JsonValue value)
            return false;

        if (value.TryGetValue<string>(out var stringValue))
        {
            text = stringValue ?? "";
            return true;
        }

        return false;
    }

    private static void CopyIfPresent(JsonObject source, JsonObject target, string propertyName)
    {
        if (source.TryGetPropertyValue(propertyName, out var node) && node != null)
            target[propertyName] = node.DeepClone();
    }

    private static void CopyRenamedIfPresent(JsonObject source, JsonObject target, string sourceName, string targetName)
    {
        if (source.TryGetPropertyValue(sourceName, out var node) && node != null)
            target[targetName] = node.DeepClone();
    }

    private static JsonObject CloneObject(JsonObject source) => (JsonObject)source.DeepClone();

    private static string ReasonPhrase(int statusCode) => statusCode switch
    {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        _ => "Error",
    };

    private sealed record HttpRequestData(
        string Method,
        string Path,
        IReadOnlyDictionary<string, string> Headers,
        byte[] Body);

    private sealed class ProxyHttpException : Exception
    {
        public ProxyHttpException(int statusCode, string message) : base(message)
        {
            StatusCode = statusCode;
        }

        public int StatusCode { get; }
    }

    private sealed class UpstreamHttpException : Exception
    {
        public UpstreamHttpException(int statusCode, string contentType, byte[] body) : base($"upstream returned HTTP {statusCode}")
        {
            StatusCode = statusCode;
            ContentType = contentType;
            Body = body;
        }

        public int StatusCode { get; }
        public string ContentType { get; }
        public byte[] Body { get; }
    }
}
