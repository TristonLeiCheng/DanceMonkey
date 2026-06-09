using System.Windows;
using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;
using DesktopAssistant.Views;

namespace DesktopAssistant.Services;

/// <summary>
/// WPF 审批提示：弹出 <see cref="AgentApprovalDialog"/> 收集用户决定。
/// </summary>
public sealed class WpfApprovalPrompt : IApprovalPrompt
{
    private readonly Func<Window?> _getOwner;

    public WpfApprovalPrompt(Func<Window?> getOwner)
    {
        _getOwner = getOwner;
    }

    public WpfApprovalPrompt(Window? owner) : this(() => owner) { }

    public Task<ApprovalDecision> AskAsync(ApprovalRequest request, AgentSession session, CancellationToken ct)
    {
        var app = Application.Current;
        if (app?.Dispatcher == null)
            return Task.FromResult(ApprovalDecision.Reject);

        return app.Dispatcher.InvokeAsync(() =>
        {
            ct.ThrowIfCancellationRequested();
            var owner = _getOwner() ?? app.MainWindow;
            var dlg = new AgentApprovalDialog(request, session)
            {
                Owner = owner,
                WindowStartupLocation = owner != null
                    ? WindowStartupLocation.CenterOwner
                    : WindowStartupLocation.CenterScreen,
            };
            dlg.ShowDialog();
            var decision = dlg.Decision;
            AgentAuditLog.Approval(
                request.Tool,
                decision.ToString(),
                request.Summary);
            return decision;
        }, System.Windows.Threading.DispatcherPriority.Normal, ct).Task;
    }
}
