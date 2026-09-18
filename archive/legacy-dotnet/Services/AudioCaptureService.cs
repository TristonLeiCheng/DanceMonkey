using NAudio.Wave;

namespace DesktopAssistant.Services;

/// <summary>
/// 麦克风 / 系统回放音频采集服务。
/// 持续录制 PCM 16kHz/16bit/Mono，按固定时长切片回调。
/// </summary>
public sealed class AudioCaptureService : IDisposable
{
    public enum AudioSource { Microphone, Loopback }

    /// <summary>每段音频就绪时触发，携带 WAV 字节和段序号。</summary>
    public event Action<byte[], int>? SegmentReady;

    /// <summary>采集出错时触发。</summary>
    public event Action<string>? ErrorOccurred;

    /// <summary>当前是否正在录制。</summary>
    public bool IsRecording { get; private set; }

    private readonly AudioSource _source;
    private readonly int _segmentSeconds;

    private IWaveIn? _capture;
    private WaveFormat? _targetFormat;
    private MemoryStream? _buffer;
    private int _segmentIndex;
    private DateTime _segmentStart;
    private bool _paused;
    private bool _disposed;

    // 目标格式：16 kHz / 16 bit / Mono（Whisper 推荐）
    private static readonly WaveFormat TargetFormat = new(16000, 16, 1);

    public AudioCaptureService(AudioSource source = AudioSource.Microphone, int segmentSeconds = 5)
    {
        _source = source;
        _segmentSeconds = Math.Clamp(segmentSeconds, 2, 30);
    }

    /// <summary>列出可用的麦克风设备。</summary>
    public static List<(int Index, string Name)> ListMicrophones()
    {
        var result = new List<(int, string)>();
        for (var i = 0; i < WaveInEvent.DeviceCount; i++)
        {
            var cap = WaveInEvent.GetCapabilities(i);
            result.Add((i, cap.ProductName));
        }
        return result;
    }

    public void Start()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(AudioCaptureService));
        if (IsRecording) return;

        try
        {
            _segmentIndex = 0;
            _paused = false;

            if (_source == AudioSource.Loopback)
            {
                var loopback = new WasapiLoopbackCapture();
                _targetFormat = loopback.WaveFormat;
                _capture = loopback;
            }
            else
            {
                var mic = new WaveInEvent
                {
                    WaveFormat = TargetFormat,
                    BufferMilliseconds = 100
                };
                _targetFormat = TargetFormat;
                _capture = mic;
            }

            _buffer = new MemoryStream();
            _segmentStart = DateTime.UtcNow;

            _capture.DataAvailable += OnDataAvailable;
            _capture.RecordingStopped += OnRecordingStopped;
            _capture.StartRecording();
            IsRecording = true;
        }
        catch (Exception ex)
        {
            IsRecording = false;
            ErrorOccurred?.Invoke($"无法启动录音：{ex.Message}");
        }
    }

    public void Pause()
    {
        _paused = true;
    }

    public void Resume()
    {
        _paused = false;
        _segmentStart = DateTime.UtcNow;
    }

    public void Stop()
    {
        if (!IsRecording) return;
        try
        {
            _capture?.StopRecording();
        }
        catch
        {
            // 设备可能已断开
        }
        FlushCurrentSegment();
        IsRecording = false;
    }

    private void OnDataAvailable(object? sender, WaveInEventArgs e)
    {
        if (_paused || e.BytesRecorded == 0) return;

        // 如果是 Loopback，需要重采样到目标格式
        byte[] pcm;
        if (_source == AudioSource.Loopback && _targetFormat != null && !_targetFormat.Equals(TargetFormat))
        {
            pcm = ResampleToTarget(e.Buffer, e.BytesRecorded, _targetFormat);
        }
        else
        {
            pcm = new byte[e.BytesRecorded];
            Array.Copy(e.Buffer, pcm, e.BytesRecorded);
        }

        _buffer?.Write(pcm, 0, pcm.Length);

        // 检查是否达到切片时长
        if ((DateTime.UtcNow - _segmentStart).TotalSeconds >= _segmentSeconds)
        {
            FlushCurrentSegment();
            _segmentStart = DateTime.UtcNow;
        }
    }

    private void FlushCurrentSegment()
    {
        if (_buffer == null || _buffer.Length == 0) return;

        var pcmBytes = _buffer.ToArray();
        _buffer.SetLength(0);

        var wavBytes = PcmToWav(pcmBytes, TargetFormat);
        var idx = _segmentIndex++;
        SegmentReady?.Invoke(wavBytes, idx);
    }

    private void OnRecordingStopped(object? sender, StoppedEventArgs e)
    {
        if (e.Exception != null)
            ErrorOccurred?.Invoke($"录音异常中断：{e.Exception.Message}");
    }

    /// <summary>将 PCM 数据包装为完整 WAV 文件字节。</summary>
    private static byte[] PcmToWav(byte[] pcm, WaveFormat fmt)
    {
        using var ms = new MemoryStream();
        using (var writer = new WaveFileWriter(ms, fmt))
        {
            writer.Write(pcm, 0, pcm.Length);
        }
        return ms.ToArray();
    }

    /// <summary>将非目标格式的 PCM 重采样为 16kHz/16bit/Mono。</summary>
    private static byte[] ResampleToTarget(byte[] buffer, int count, WaveFormat sourceFormat)
    {
        using var sourceStream = new RawSourceWaveStream(new MemoryStream(buffer, 0, count), sourceFormat);
        using var resampler = new MediaFoundationResampler(sourceStream, TargetFormat)
        {
            ResamplerQuality = 60
        };
        using var output = new MemoryStream();
        var buf = new byte[4096];
        int read;
        while ((read = resampler.Read(buf, 0, buf.Length)) > 0)
            output.Write(buf, 0, read);
        return output.ToArray();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        Stop();
        if (_capture != null)
        {
            _capture.DataAvailable -= OnDataAvailable;
            _capture.RecordingStopped -= OnRecordingStopped;
            _capture.Dispose();
            _capture = null;
        }
        _buffer?.Dispose();
        _buffer = null;
    }
}
