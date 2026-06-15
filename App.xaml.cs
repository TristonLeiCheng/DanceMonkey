using System.IO;
using System.Text;
using System.Windows;
using DesktopAssistant.Services;

namespace DesktopAssistant;

public partial class App : Application
{
    public static ConfigService Config { get; } = new();

    public static ClipboardHistoryService ClipboardHistory { get; } = new();

    public static CodexProxyDesktopService CodexProxy { get; } = new();

    public static FolderSyncSchedulerService FolderSyncScheduler { get; } = new(Config);

    private static readonly string CrashLogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "DanceMonkey",
        "logs",
        "crash.log");

    [STAThread]
    public static int Main(string[] args)
    {
        StartupDiagnostics.Initialize(args);
        if (LocalInstallBootstrap.TryRelaunchFromCanonicalInstall(args))
        {
            StartupDiagnostics.Log("LocalInstallBootstrap: relaunched from canonical install dir");
            return 0;
        }

        try
        {
            var app = new App();
            app.InitializeComponent();
            StartupDiagnostics.Log("App.InitializeComponent OK");
            app.Run();
            StartupDiagnostics.Log("App.Run returned");
            return 0;
        }
        catch (Exception ex)
        {
            StartupDiagnostics.Fatal("Main", ex);
            return 1;
        }
    }

    protected override void OnStartup(StartupEventArgs e)
    {
        StartupDiagnostics.Log("OnStartup.begin");
        InstallGlobalExceptionLogging();
        ShutdownMode = ShutdownMode.OnExplicitShutdown;

        try
        {
            var cfg = Config.Load();
            LocalizationManager.Initialize(cfg.Language);
            StartupDiagnostics.Log("Localization OK");

            var main = new MainWindow();
            StartupDiagnostics.Log("MainWindow.ctor OK");
            MainWindow = main;
            main.Show();
            main.Activate();
            main.Focus();
            StartupDiagnostics.Log("MainWindow.Show OK");

            if (StartupDiagnostics.IsDiagMode)
            {
                MessageBox.Show(
                    "主窗口已创建。\n\n若仍看不到界面，请查看任务栏托盘图标。\n\n日志:\n" + StartupDiagnostics.LogFilePath,
                    "DanceMonkey 诊断",
                    MessageBoxButton.OK,
                    MessageBoxImage.Information);
            }
        }
        catch (Exception ex)
        {
            AppendCrashLog("OnStartup", ex);
            StartupDiagnostics.Fatal("OnStartup", ex);
            Shutdown(1);
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        FolderSyncScheduler.Dispose();
        CodexProxy.Dispose();
        base.OnExit(e);
    }

    private static void InstallGlobalExceptionLogging()
    {
        Current.DispatcherUnhandledException += (_, args) =>
        {
            AppendCrashLog("DispatcherUnhandledException", args.Exception);
            StartupDiagnostics.Log("DispatcherUnhandledException: " + args.Exception.Message);
            try
            {
                MessageBox.Show(
                    args.Exception.Message + "\n\n" + args.Exception.GetType().Name +
                    "\n\n已写入:\n" + CrashLogPath + "\n" + StartupDiagnostics.LogFilePath,
                    "DanceMonkey 运行错误",
                    MessageBoxButton.OK,
                    MessageBoxImage.Error);
            }
            catch
            {
                // ignore
            }

            args.Handled = true;
        };

        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
        {
            AppendCrashLog("AppDomain.UnhandledException", args.ExceptionObject as Exception);
            if (args.ExceptionObject is Exception ex)
                StartupDiagnostics.Log("AppDomain.UnhandledException: " + ex.Message);
        };

        TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            AppendCrashLog("TaskScheduler.UnobservedTaskException", args.Exception);
            args.SetObserved();
        };
    }

    private static void AppendCrashLog(string source, Exception? ex)
    {
        try
        {
            var dir = Path.GetDirectoryName(CrashLogPath);
            if (!string.IsNullOrEmpty(dir))
                Directory.CreateDirectory(dir);

            var sb = new StringBuilder();
            sb.AppendLine("========================================");
            sb.AppendLine(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff"));
            sb.AppendLine(source);
            if (ex != null)
                AppendException(sb, ex, 0);
            else
                sb.AppendLine("(null exception)");

            File.AppendAllText(CrashLogPath, sb.ToString(), Encoding.UTF8);
        }
        catch
        {
            // ignore
        }
    }

    private static void AppendException(StringBuilder sb, Exception ex, int depth)
    {
        var indent = new string(' ', depth * 2);
        sb.AppendLine($"{indent}{ex.GetType().FullName ?? "Exception"}");
        sb.AppendLine($"{indent}{ex.Message}");
        sb.AppendLine(ex.StackTrace ?? $"{indent}(no stack)");

        if (ex.InnerException != null)
        {
            sb.AppendLine($"{indent}InnerException:");
            AppendException(sb, ex.InnerException, depth + 1);
        }
    }
}
