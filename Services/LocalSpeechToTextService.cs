using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

/// <summary>
/// 本地离线语音转文字（whisper.cpp）封装。
/// </summary>
public static class LocalSpeechToTextService
{
    public static bool ValidateOptions(SpeechToTextOptions options, out string error)
    {
        if (options == null)
        {
            error = "参数不能为空。";
            return false;
        }

        if (string.IsNullOrWhiteSpace(options.WhisperExePath) || !File.Exists(options.WhisperExePath))
        {
            error = "未找到 whisper.cpp 可执行文件，请在设置中配置正确路径。";
            return false;
        }

        if (string.IsNullOrWhiteSpace(options.ModelPath) || !File.Exists(options.ModelPath))
        {
            error = "未找到本地模型文件，请在设置中配置正确路径。";
            return false;
        }

        if (options.Threads <= 0)
        {
            error = "线程数必须大于 0。";
            return false;
        }

        if (options.TimeoutSeconds < 30)
        {
            error = "超时时间建议不小于 30 秒。";
            return false;
        }

        error = "";
        return true;
    }

    public static async Task<SpeechToTextResult> TranscribeFileAsync(
        string audioPath,
        SpeechToTextOptions options,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(audioPath) || !File.Exists(audioPath))
        {
            return new SpeechToTextResult
            {
                Success = false,
                Error = "音频文件不存在。"
            };
        }

        if (!ValidateOptions(options, out var validationError))
        {
            return new SpeechToTextResult
            {
                Success = false,
                Error = validationError
            };
        }

        var started = Stopwatch.StartNew();
        var outputPrefix = Path.Combine(
            Path.GetTempPath(),
            $"dm_stt_{DateTime.Now:yyyyMMdd_HHmmss}_{Guid.NewGuid():N}");
        var outputTxt = outputPrefix + ".txt";

        var args = BuildWhisperArgs(audioPath, outputPrefix, options);
        var psi = new ProcessStartInfo
        {
            FileName = options.WhisperExePath,
            Arguments = args,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(options.WhisperExePath) ?? AppContext.BaseDirectory,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };

        using var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
        var stdOut = new StringBuilder();
        var stdErr = new StringBuilder();
        process.OutputDataReceived += (_, e) =>
        {
            if (!string.IsNullOrWhiteSpace(e.Data))
                stdOut.AppendLine(e.Data);
        };
        process.ErrorDataReceived += (_, e) =>
        {
            if (!string.IsNullOrWhiteSpace(e.Data))
                stdErr.AppendLine(e.Data);
        };

        try
        {
            if (!process.Start())
            {
                return new SpeechToTextResult
                {
                    Success = false,
                    Error = "无法启动 whisper.cpp 进程。"
                };
            }

            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(options.TimeoutSeconds));
            using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeoutCts.Token);
            try
            {
                await process.WaitForExitAsync(linkedCts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                TryKill(process);
                if (cancellationToken.IsCancellationRequested)
                {
                    return new SpeechToTextResult
                    {
                        Success = false,
                        Error = "已取消语音转写。",
                        Elapsed = started.Elapsed
                    };
                }

                return new SpeechToTextResult
                {
                    Success = false,
                    Error = $"语音转写超时（>{options.TimeoutSeconds} 秒）。",
                    Elapsed = started.Elapsed
                };
            }

            if (process.ExitCode != 0)
            {
                var err = stdErr.ToString().Trim();
                if (string.IsNullOrWhiteSpace(err))
                    err = stdOut.ToString().Trim();

                return new SpeechToTextResult
                {
                    Success = false,
                    Error = string.IsNullOrWhiteSpace(err)
                        ? $"语音转写失败，进程退出码：{process.ExitCode}"
                        : err,
                    Elapsed = started.Elapsed
                };
            }

            string text;
            if (File.Exists(outputTxt))
                text = (await File.ReadAllTextAsync(outputTxt, cancellationToken).ConfigureAwait(false)).Trim();
            else
                text = stdOut.ToString().Trim();

            if (!options.AutoPunctuation && !string.IsNullOrWhiteSpace(text))
            {
                // 仅在用户明确关闭时做轻量去标点处理。
                text = Regex.Replace(text, @"[\p{P}\p{S}]+", " ").Trim();
                text = Regex.Replace(text, @"\s{2,}", " ");
            }

            if (string.IsNullOrWhiteSpace(text))
            {
                return new SpeechToTextResult
                {
                    Success = false,
                    Error = "未识别到可用文本，请检查音频质量或模型语言设置。",
                    Elapsed = started.Elapsed
                };
            }

            return new SpeechToTextResult
            {
                Success = true,
                Text = text,
                Elapsed = started.Elapsed
            };
        }
        catch (Exception ex)
        {
            return new SpeechToTextResult
            {
                Success = false,
                Error = $"本地语音转写失败：{ex.Message}",
                Elapsed = started.Elapsed
            };
        }
        finally
        {
            TryDeleteFile(outputTxt);
        }
    }

    private static string BuildWhisperArgs(string audioPath, string outputPrefix, SpeechToTextOptions options)
    {
        static string Q(string p) => $"\"{p}\"";
        var language = string.IsNullOrWhiteSpace(options.Language) ? "zh" : options.Language.Trim().ToLowerInvariant();
        var threads = Math.Clamp(options.Threads, 1, Environment.ProcessorCount);
        // 生成 txt 输出，方便稳定读取（stdout 在不同编译参数下可能含日志混排）
        return $"-m {Q(options.ModelPath)} -f {Q(audioPath)} -l {language} -t {threads} -otxt -of {Q(outputPrefix)}";
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
        }
        catch
        {
            // ignore
        }
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path))
                File.Delete(path);
        }
        catch
        {
            // ignore
        }
    }
}
