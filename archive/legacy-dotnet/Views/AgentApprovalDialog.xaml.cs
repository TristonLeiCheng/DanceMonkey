using System.Windows;
using DanceMonkey.Agent.Core.Models;

namespace DesktopAssistant.Views;

public partial class AgentApprovalDialog : Window
{
    public ApprovalDecision Decision { get; private set; } = ApprovalDecision.Reject;

    public AgentApprovalDialog(ApprovalRequest request, AgentSession session)
    {
        InitializeComponent();

        ToolText.Text = $"工具: {request.Tool}   |   风险: {FormatRisk(request.Risk)}   |   模式: {session.Mode}";
        SummaryText.Text = request.Summary;

        RiskIcon.Text = request.Risk switch
        {
            ToolRiskLevel.ReadOnly => "📖",
            ToolRiskLevel.Write => "✏️",
            ToolRiskLevel.Shell => "💻",
            ToolRiskLevel.Dangerous => "⚠️",
            _ => "❔",
        };

        if (!string.IsNullOrWhiteSpace(request.Details))
        {
            DetailsBox.Text = request.Details;
            DetailsBox.Visibility = Visibility.Visible;
        }

        HintText.Text = request.Risk switch
        {
            ToolRiskLevel.Shell => "该命令会在你的机器上执行，请核对后再允许。超时默认 60 秒。",
            ToolRiskLevel.Write => "将修改文件，允许前请核对目标路径。",
            ToolRiskLevel.Dangerous => "高风险操作——即使在 Auto 模式下也每次询问。",
            _ => "只读操作不会修改任何内容。",
        };

        if (string.IsNullOrEmpty(request.Scope))
            AllowScopeBtn.Visibility = Visibility.Collapsed;
    }

    private static string FormatRisk(ToolRiskLevel r) => r switch
    {
        ToolRiskLevel.ReadOnly => "只读",
        ToolRiskLevel.Write => "写入",
        ToolRiskLevel.Shell => "执行命令",
        ToolRiskLevel.Dangerous => "高危",
        _ => r.ToString(),
    };

    private void Reject_OnClick(object sender, RoutedEventArgs e)
    {
        Decision = ApprovalDecision.Reject;
        DialogResult = true;
        Close();
    }

    private void AllowOnce_OnClick(object sender, RoutedEventArgs e)
    {
        Decision = ApprovalDecision.AllowOnce;
        DialogResult = true;
        Close();
    }

    private void AllowScope_OnClick(object sender, RoutedEventArgs e)
    {
        Decision = ApprovalDecision.AllowSessionScope;
        DialogResult = true;
        Close();
    }
}
