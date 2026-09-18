using System.Runtime.ExceptionServices;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Automation.Provider;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Markup;
using System.Xml.Linq;
using Xunit;

namespace DanceMonkey.Ui.Tests;

public sealed class ThemeResourceTests
{
    private static readonly XNamespace XamlNamespace = "http://schemas.microsoft.com/winfx/2006/xaml";

    [Fact]
    public void DesignTokens_DefineSchemeOneCorePalette()
    {
        var document = LoadXaml("Themes", "DesignTokens.xaml");

        AssertBrushColor(document, "BrushAccent", "#6254F5");
        AssertBrushColor(document, "BrushPageBg", "#F7F8FC");
        AssertBrushColor(document, "BrushSidebarActive", "#EDEBFF");
    }

    [Fact]
    public void Controls_DefineRequiredSharedStyles()
    {
        var document = LoadXaml("Themes", "Controls.xaml");
        var keys = ResourceKeys(document).ToHashSet(StringComparer.Ordinal);

        string[] requiredStyles =
        [
            "UiBtnPrimary",
            "UiBtnSecondary",
            "UiBtnGhost",
            "UiBtnDanger",
            "UiTextBox",
            "UiComboBox",
            "UiCard"
        ];

        Assert.All(requiredStyles, key => Assert.Contains(key, keys));
    }

    [Fact]
    public void App_MergesDesignTokensBeforeControls()
    {
        var document = LoadXaml("App.xaml");
        var sources = document
            .Descendants()
            .Where(element => element.Name.LocalName == "ResourceDictionary")
            .Select(element => (string?)element.Attribute("Source"))
            .Where(source => source is not null)
            .ToList();

        var tokensIndex = sources.IndexOf("Themes/DesignTokens.xaml");
        var controlsIndex = sources.IndexOf("Themes/Controls.xaml");

        Assert.True(tokensIndex >= 0, "App.xaml must merge Themes/DesignTokens.xaml.");
        Assert.True(controlsIndex >= 0, "App.xaml must merge Themes/Controls.xaml.");
        Assert.True(tokensIndex < controlsIndex, "DesignTokens.xaml must be merged before Controls.xaml.");
    }

    [Fact]
    public void ThemeDictionaries_DoNotDuplicateRemainingAppResourceKeys()
    {
        var tokenKeys = ResourceKeys(LoadXaml("Themes", "DesignTokens.xaml"));
        var controlKeys = ResourceKeys(LoadXaml("Themes", "Controls.xaml"));
        var appKeys = ResourceKeys(LoadXaml("App.xaml"));

        var duplicates = tokenKeys
            .Concat(controlKeys)
            .Concat(appKeys)
            .GroupBy(key => key, StringComparer.Ordinal)
            .Where(group => group.Count() > 1)
            .Select(group => group.Key)
            .OrderBy(key => key, StringComparer.Ordinal)
            .ToArray();

        Assert.True(duplicates.Length == 0, $"Duplicate resource keys: {string.Join(", ", duplicates)}");
    }

    [Fact]
    public void MainWindow_DoesNotReferenceLegacyGridOverlays()
    {
        var xaml = File.ReadAllText(ProjectPath("MainWindow.xaml"));

        Assert.DoesNotContain("BrushSidebarGridOverlay", xaml, StringComparison.Ordinal);
        Assert.DoesNotContain("BrushPageGridOverlay", xaml, StringComparison.Ordinal);
    }

    [Fact]
    public void MainWindow_UsesSchemeOneShellWidthsAndTokenSurfaces()
    {
        var document = LoadXaml("MainWindow.xaml");
        var root = document.Root!;
        var sidebarColumn = FindNamedElement(document, "SidebarColumn");
        var sidebarSurface = FindNamedElement(document, "SidebarSurface");
        var titleBarSurface = FindNamedElement(document, "TitleBarSurface");
        var pageCanvas = FindNamedElement(document, "PageCanvas");

        Assert.Equal("248", (string?)sidebarColumn.Attribute("Width"));
        Assert.Equal("{StaticResource BrushPageBg}", (string?)root.Attribute("Background"));
        Assert.Equal("{StaticResource BrushSidebarBg}", (string?)sidebarSurface.Attribute("Background"));
        Assert.Equal("{StaticResource BrushPageBg}", (string?)titleBarSurface.Attribute("Background"));
        Assert.Equal("{StaticResource BrushPageBg}", (string?)pageCanvas.Attribute("Fill"));
    }

    [Fact]
    public void MainWindowCodeBehind_UsesSeventyTwoAndTwoFortyEightSidebarWidths()
    {
        var codeBehind = File.ReadAllText(ProjectPath("MainWindow.xaml.cs"));

        Assert.Contains(
            "SidebarColumn.Width = new GridLength(_sidebarCollapsed ? 72 : 248);",
            codeBehind,
            StringComparison.Ordinal);
    }

    [Fact]
    public void SidebarExpanderStateCoordinator_RestoresArbitraryStateAfterRepeatedCollapseApplications()
    {
        var coordinatorType = typeof(DesktopAssistant.MainWindow).Assembly.GetType(
            "DesktopAssistant.SidebarExpanderStateCoordinator");
        Assert.NotNull(coordinatorType);

        var coordinator = Activator.CreateInstance(coordinatorType!);
        var apply = coordinatorType!.GetMethod("Apply");
        Assert.NotNull(coordinator);
        Assert.NotNull(apply);

        var initial = new[] { true, false, true, false, false };
        var collapsed = InvokeSidebarState(apply!, coordinator!, true, initial);
        Assert.All(collapsed, Assert.True);

        var repeatedCollapse = InvokeSidebarState(apply!, coordinator!, true, collapsed);
        Assert.All(repeatedCollapse, Assert.True);

        var restored = InvokeSidebarState(apply!, coordinator!, false, repeatedCollapse);
        Assert.Equal(initial, restored);
        Assert.Equal(restored, InvokeSidebarState(apply!, coordinator!, false, restored));
    }

    [Fact]
    public void SidebarExpanderStateCoordinator_CapturesTheLatestExpandedStateForEachCycle()
    {
        var coordinatorType = typeof(DesktopAssistant.MainWindow).Assembly.GetType(
            "DesktopAssistant.SidebarExpanderStateCoordinator");
        Assert.NotNull(coordinatorType);

        var coordinator = Activator.CreateInstance(coordinatorType!);
        var apply = coordinatorType!.GetMethod("Apply");
        Assert.NotNull(coordinator);
        Assert.NotNull(apply);

        var first = new[] { true, false, false, false, false };
        var firstCollapsed = InvokeSidebarState(apply!, coordinator!, true, first);
        Assert.Equal(first, InvokeSidebarState(apply!, coordinator!, false, firstCollapsed));

        var updated = new[] { true, true, false, true, false };
        var secondCollapsed = InvokeSidebarState(apply!, coordinator!, true, updated);
        Assert.Equal(updated, InvokeSidebarState(apply!, coordinator!, false, secondCollapsed));
    }

    [Fact]
    public void SidebarExpanderStateCoordinator_PromotesNavigatedGroupWithoutOpeningUnrelatedSavedGroups()
    {
        var coordinatorType = typeof(DesktopAssistant.MainWindow).Assembly.GetType(
            "DesktopAssistant.SidebarExpanderStateCoordinator");
        Assert.NotNull(coordinatorType);

        var coordinator = Activator.CreateInstance(coordinatorType!);
        var apply = coordinatorType!.GetMethod("Apply");
        var markExpanded = coordinatorType.GetMethod("MarkExpanded");
        Assert.NotNull(coordinator);
        Assert.NotNull(apply);
        Assert.NotNull(markExpanded);

        var initial = new[] { true, true, false, false, false };
        var collapsed = InvokeSidebarState(apply!, coordinator!, true, initial);
        Assert.All(collapsed, Assert.True);

        markExpanded!.Invoke(coordinator, [2]);
        var restored = InvokeSidebarState(apply!, coordinator!, false, collapsed);

        Assert.Equal(new[] { true, true, true, false, false }, restored);
    }

    [Fact]
    public void MainWindow_MapsEveryNavigableSidebarPageToItsExpanderGroup()
    {
        var mapper = typeof(DesktopAssistant.MainWindow).GetMethod(
            "GetSidebarGroupIndex",
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
        Assert.NotNull(mapper);

        var expected = new Dictionary<DesktopAssistant.AppPage, int>
        {
            [DesktopAssistant.AppPage.Today] = 0,
            [DesktopAssistant.AppPage.AiChat] = 0,
            [DesktopAssistant.AppPage.Notes] = 0,
            [DesktopAssistant.AppPage.Ppt] = 0,
            [DesktopAssistant.AppPage.Todo] = 0,
            [DesktopAssistant.AppPage.ScheduledReminders] = 0,
            [DesktopAssistant.AppPage.QuickAccess] = 0,
            [DesktopAssistant.AppPage.Email] = 0,
            [DesktopAssistant.AppPage.Translate] = 0,
            [(DesktopAssistant.AppPage)4] = 0,
            [DesktopAssistant.AppPage.MeetingAssistant] = 1,
            [DesktopAssistant.AppPage.FileManager] = 2,
            [DesktopAssistant.AppPage.FileTools] = 2,
            [DesktopAssistant.AppPage.PdfTools] = 2,
            [DesktopAssistant.AppPage.NetworkMonitor] = 3,
            [DesktopAssistant.AppPage.Cleanup] = 3,
            [DesktopAssistant.AppPage.CodexProxy] = 3,
            [DesktopAssistant.AppPage.PasswordVault] = 3,
            [DesktopAssistant.AppPage.ProcessDiagnostics] = 3,
            [DesktopAssistant.AppPage.Dance] = 4
        };

        Assert.All(
            expected,
            mapping => Assert.Equal(
                mapping.Value,
                (int?)mapper!.Invoke(null, [mapping.Key])));
        Assert.Null(mapper!.Invoke(null, [DesktopAssistant.AppPage.Settings]));
        Assert.Null(mapper.Invoke(null, [DesktopAssistant.AppPage.Skills]));
    }

    [Fact]
    public void CaptionAndSidebarToggle_ExposeLocalizedAutomationNamesFromStartup()
    {
        var document = LoadXaml("MainWindow.xaml");
        var minimize = document
            .Descendants()
            .Single(element => (string?)element.Attribute("Click") == "CaptionMinimize_OnClick");
        var maximize = FindNamedElement(document, "BtnCaptionMaximize");
        var close = document
            .Descendants()
            .Single(element => (string?)element.Attribute("Click") == "CaptionClose_OnClick");
        var sidebarToggle = FindNamedElement(document, "BtnSidebarToggle");

        Assert.Equal(
            "{DynamicResource TitleBar.Minimize}",
            (string?)minimize.Attribute("AutomationProperties.Name"));
        Assert.Equal(
            "{DynamicResource TitleBar.Maximize}",
            (string?)maximize.Attribute("AutomationProperties.Name"));
        Assert.Equal(
            "{DynamicResource TitleBar.Close}",
            (string?)close.Attribute("AutomationProperties.Name"));
        Assert.Equal(
            "{DynamicResource Nav.CollapseSidebar}",
            (string?)sidebarToggle.Attribute("AutomationProperties.Name"));

        var codeBehind = File.ReadAllText(ProjectPath("MainWindow.xaml.cs"));
        Assert.Contains(
            "BtnCaptionMaximize.SetResourceReference(AutomationProperties.NameProperty, captionResourceKey);",
            codeBehind,
            StringComparison.Ordinal);
        Assert.Contains(
            "BtnSidebarToggle.SetResourceReference(AutomationProperties.NameProperty, toggleResourceKey);",
            codeBehind,
            StringComparison.Ordinal);
    }

    [Fact]
    public void EveryNavigationButton_HasStartupLocalizedAutomationNameAndTooltip()
    {
        var document = LoadXaml("MainWindow.xaml");
        var navButtons = document
            .Descendants()
            .Where(element =>
                element.Name.LocalName == "Button"
                && (string?)element.Attribute("Style") == "{StaticResource NavButtonStyle}")
            .ToDictionary(
                element => (string?)element.Attribute(XamlNamespace + "Name")
                    ?? throw new InvalidDataException("Navigation button must have x:Name."),
                StringComparer.Ordinal);
        var expectedNames = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["NavToday"] = "{DynamicResource Notes.Today}",
            ["NavAiChat"] = "{DynamicResource Nav.AiChat}",
            ["NavNotes"] = "{DynamicResource Nav.Notes}",
            ["NavPpt"] = "{DynamicResource Nav.Ppt}",
            ["NavTodo"] = "{DynamicResource Nav.Todo}",
            ["NavReminders"] = "{DynamicResource Nav.ScheduledReminders}",
            ["NavQuickAccess"] = "{DynamicResource Nav.QuickAccess}",
            ["NavMeeting"] = "{DynamicResource Nav.Meeting}",
            ["NavFileManager"] = "{DynamicResource Nav.FileManager}",
            ["NavFileTools"] = "{DynamicResource Nav.FileTools}",
            ["NavPdfTools"] = "{DynamicResource Nav.PdfTools}",
            ["NavCleanup"] = "{DynamicResource Nav.Cleanup}",
            ["NavCodexProxy"] = "{DynamicResource Nav.CodexProxy}",
            ["NavNetwork"] = "{DynamicResource Nav.Network}",
            ["NavPasswordVault"] = "{DynamicResource Nav.PasswordVault}",
            ["NavProcessDiag"] = "{Binding Text, ElementName=NavProcessDiagLabel}",
            ["NavDance"] = "{DynamicResource Nav.Dance}",
            ["NavSettings"] = "{DynamicResource Nav.Settings}"
        };

        Assert.Equal(18, navButtons.Count);
        Assert.Equal(expectedNames.Keys.Order(), navButtons.Keys.Order());
        Assert.All(
            expectedNames,
            expected =>
            {
                var button = navButtons[expected.Key];
                Assert.Equal(
                    expected.Value,
                    (string?)button.Attribute("AutomationProperties.Name"));
                Assert.False(
                    string.IsNullOrWhiteSpace((string?)button.Attribute("ToolTip")),
                    $"{expected.Key} must have a localized startup tooltip.");
            });

        var codeBehind = File.ReadAllText(ProjectPath("MainWindow.xaml.cs"));
        Assert.DoesNotContain("AutomationProperties.SetName(btn", codeBehind, StringComparison.Ordinal);
        Assert.DoesNotContain("btn.ToolTip = label.Text", codeBehind, StringComparison.Ordinal);
    }

    [Fact]
    public void ProcessDiagnosticsNavigationLabel_LocalizesAtStartupAndAfterRuntimeSettingsChanges()
    {
        var resolver = typeof(DesktopAssistant.MainWindow).GetMethod(
            "GetProcessDiagnosticsLabel",
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
        Assert.NotNull(resolver);

        Assert.Equal("Process Diagnostics", resolver!.Invoke(null, ["en-US"]));
        Assert.Equal("进程诊断", resolver.Invoke(null, ["zh-CN"]));

        var codeBehind = File.ReadAllText(ProjectPath("MainWindow.xaml.cs"));
        Assert.True(
            codeBehind.Split("RefreshLocalizedShellText();", StringSplitOptions.None).Length - 1 >= 2,
            "Localized shell text must refresh both during startup and after settings change.");
    }

    [Fact]
    public void SidebarNavigation_UsesLavenderSelectedPillsAndAccessibleInteractionStates()
    {
        var tokens = LoadXaml("Themes", "DesignTokens.xaml");
        var document = LoadXaml("MainWindow.xaml");
        var style = FindResource(document, "NavButtonStyle");
        var accentBar = style
            .Descendants()
            .Single(element => (string?)element.Attribute(XamlNamespace + "Name") == "AccentBar");
        var activeTrigger = style
            .Descendants()
            .Single(element =>
                element.Name.LocalName == "DataTrigger"
                && (string?)element.Attribute("Value") == "True"
                && ((string?)element.Attribute("Binding"))?.Contains(
                    "NavButtonHelper.IsNavActive",
                    StringComparison.Ordinal) == true);
        var activePressedTrigger = style
            .Descendants()
            .Single(element =>
                element.Name.LocalName == "MultiDataTrigger"
                && element
                    .Descendants()
                    .Where(condition => condition.Name.LocalName == "Condition")
                    .Any(condition =>
                        ((string?)condition.Attribute("Binding"))?.Contains(
                            "IsPressed",
                            StringComparison.Ordinal) == true));
        var inactiveHoverTrigger = style
            .Descendants()
            .Single(element =>
                element.Name.LocalName == "MultiDataTrigger"
                && element
                    .Descendants()
                    .Where(condition => condition.Name.LocalName == "Condition")
                    .Any(condition =>
                        (string?)condition.Attribute("Value") == "False"
                        && ((string?)condition.Attribute("Binding"))?.Contains(
                            "NavButtonHelper.IsNavActive",
                            StringComparison.Ordinal) == true));

        AssertTriggerSetter(
            activeTrigger,
            null,
            "Background",
            "{StaticResource BrushSidebarActive}");
        AssertTriggerSetter(
            activeTrigger,
            null,
            "Foreground",
            "{StaticResource BrushSidebarTextActive}");
        Assert.DoesNotContain(
            style.Descendants(),
            element => (string?)element.Attribute(XamlNamespace + "Name") == "SelectionMarker");
        Assert.Equal("{StaticResource BrushAccent}", (string?)accentBar.Attribute("Background"));
        Assert.Contains(
            "NavButtonHelper.IsNavActive",
            (string?)accentBar.Attribute("Visibility") ?? string.Empty,
            StringComparison.Ordinal);

        AssertStyleTriggerSetter(
            style,
            "IsPressed",
            "True",
            null,
            "Background",
            "{StaticResource BrushAccentMuted}");
        AssertStyleTriggerSetter(
            style,
            "IsPressed",
            "True",
            null,
            "Foreground",
            "{StaticResource BrushSidebarTextActive}");
        AssertTriggerSetter(
            inactiveHoverTrigger,
            null,
            "Foreground",
            "{StaticResource BrushSidebarTextActive}");
        AssertStyleTriggerSetter(
            style,
            "IsKeyboardFocused",
            "True",
            null,
            "BorderBrush",
            "{StaticResource BrushBorderFocus}");
        AssertTriggerSetter(
            activePressedTrigger,
            null,
            "Background",
            "{StaticResource BrushAccentPressed}");
        AssertTriggerSetter(
            activePressedTrigger,
            null,
            "Foreground",
            "{StaticResource BrushTextOnAccent}");

        Assert.True(
            ContrastRatio(BrushColor(tokens, "BrushSidebarText"), BrushColor(tokens, "BrushSidebarBg")) >= 4.5);
        Assert.True(
            ContrastRatio(BrushColor(tokens, "BrushSidebarTextActive"), BrushColor(tokens, "BrushSidebarHover")) >= 4.5);
        Assert.True(
            ContrastRatio(BrushColor(tokens, "BrushSidebarTextActive"), BrushColor(tokens, "BrushAccentMuted")) >= 4.5);
    }

    [Fact]
    public void SidebarSectionHeadings_AreCompactTransparentAndReadable()
    {
        var document = LoadXaml("MainWindow.xaml");
        var headingStyle = FindResource(document, "SidebarSectionHeading");
        var expanderStyle = FindResource(document, "SidebarExpanderStyle");
        var expanderChevron = expanderStyle
            .Descendants()
            .Single(element => (string?)element.Attribute(XamlNamespace + "Name") == "ExpArrow");
        var headerTextBlocks = document
            .Descendants()
            .Where(element =>
                element.Name.LocalName == "Expander.Header")
            .SelectMany(header => header.Descendants())
            .Where(element => element.Name.LocalName == "TextBlock")
            .ToArray();

        Assert.Equal("Transparent", StyleSetterValue(headingStyle, "Background"));
        Assert.Equal(
            "{StaticResource BrushSidebarMuted}",
            StyleSetterValue(headingStyle, "Foreground"));
        Assert.Equal("10.5", StyleSetterValue(headingStyle, "FontSize"));
        Assert.Equal("Segoe MDL2 Assets", (string?)expanderChevron.Attribute("FontFamily"));
        Assert.Equal("\uE70D", (string?)expanderChevron.Attribute("Text"));
        Assert.Equal(
            "{StaticResource BrushSidebarText}",
            (string?)expanderChevron.Attribute("Foreground"));
        var tokens = LoadXaml("Themes", "DesignTokens.xaml");
        Assert.True(
            ContrastRatio(BrushColor(tokens, "BrushSidebarText"), BrushColor(tokens, "BrushSidebarBg")) >= 3.0);
        AssertStyleTriggerSetter(
            expanderStyle,
            "IsExpanded",
            "False",
            "ExpArrow",
            "Text",
            "\uE76C");
        Assert.NotEmpty(headerTextBlocks);
        Assert.All(
            headerTextBlocks,
            textBlock => Assert.Equal(
                "{StaticResource SidebarSectionHeading}",
                (string?)textBlock.Attribute("Style")));
    }

    [Fact]
    public void SidebarExpanderHeader_UsesAnExplicitTransparentToggleTemplate()
    {
        var document = LoadXaml("MainWindow.xaml");
        var expanderStyle = FindResource(document, "SidebarExpanderStyle");
        var headerToggle = expanderStyle
            .Descendants()
            .Single(element => element.Name.LocalName == "ToggleButton"
                               && (string?)element.Attribute(XamlNamespace + "Name") == "HeaderToggle");
        var headerSurface = headerToggle
            .Descendants()
            .Single(element => (string?)element.Attribute(XamlNamespace + "Name") == "HeaderSurface");

        Assert.Contains(
            headerToggle.Elements(),
            element => element.Name.LocalName == "ToggleButton.Template");
        Assert.Equal("{TemplateBinding Background}", (string?)headerSurface.Attribute("Background"));
    }

    [Fact]
    public void SidebarExpanderHeader_AppliedTemplateExposesDynamicNameToggleAndKeyboardFocus()
    {
        RunOnStaThread(() =>
        {
            var resources = LoadSidebarExpanderResources();
                var expander = new Expander
                {
                    Header = "QA header",
                    Content = new TextBlock { Text = "Content" },
                    Style = Assert.IsType<Style>(resources["SidebarExpanderStyle"]),
                    IsExpanded = false
                };
                var host = new Window
                {
                    Content = expander,
                    Width = 240,
                    Height = 120,
                    Opacity = 0,
                    ShowInTaskbar = false,
                    WindowStyle = WindowStyle.ToolWindow
                };
                host.Resources["QA.GroupName"] = "Focused QA group";
                expander.SetResourceReference(AutomationProperties.NameProperty, "QA.GroupName");

                try
                {
                    host.Show();
                    expander.ApplyTemplate();
                    var toggle = Assert.IsType<ToggleButton>(
                        expander.Template.FindName("HeaderToggle", expander));
                    var peer = new ToggleButtonAutomationPeer(toggle);
                    var toggleProvider = Assert.IsAssignableFrom<IToggleProvider>(
                        peer.GetPattern(PatternInterface.Toggle));

                    Assert.Equal("Focused QA group", peer.GetName());
                    host.Resources["QA.GroupName"] = "Updated QA group";
                    host.Dispatcher.Invoke(() => { });
                    Assert.Equal("Updated QA group", peer.GetName());
                    Assert.False(expander.IsExpanded);
                    Assert.False(toggle.IsChecked == true);
                    Assert.Equal(ToggleState.Off, toggleProvider.ToggleState);

                    expander.IsExpanded = true;
                    host.Dispatcher.Invoke(() => { });
                    Assert.True(toggle.IsChecked == true);
                    Assert.Equal(ToggleState.On, toggleProvider.ToggleState);

                    toggleProvider.Toggle();
                    host.Dispatcher.Invoke(() => { });
                    Assert.False(expander.IsExpanded);

                    Assert.True(toggle.Focus());
                    Assert.True(toggle.IsKeyboardFocused);
                    var source = PresentationSource.FromVisual(toggle);
                    Assert.NotNull(source);
                    toggle.RaiseEvent(new KeyEventArgs(
                        Keyboard.PrimaryDevice,
                        source,
                        Environment.TickCount,
                        Key.Space)
                    {
                        RoutedEvent = Keyboard.KeyDownEvent
                    });
                    toggle.RaiseEvent(new KeyEventArgs(
                        Keyboard.PrimaryDevice,
                        source,
                        Environment.TickCount,
                        Key.Space)
                    {
                        RoutedEvent = Keyboard.KeyUpEvent
                    });
                    host.Dispatcher.Invoke(() => { });
                    Assert.True(expander.IsExpanded);
                }
                finally
                {
                    host.Close();
                }
        });
    }

    [Fact]
    public void ComboBoxTemplate_SupportsEditableAndSelectionDisplayModes()
    {
        var style = FindResource(LoadXaml("Themes", "Controls.xaml"), "UiComboBox");
        var editor = style
            .Descendants()
            .Single(element =>
                element.Name.LocalName == "TextBox"
                && (string?)element.Attribute(XamlNamespace + "Name") == "PART_EditableTextBox");
        var contentSite = style
            .Descendants()
            .Single(element => (string?)element.Attribute(XamlNamespace + "Name") == "ContentSite");

        Assert.Equal("{TemplateBinding Text}", (string?)editor.Attribute("Text"));
        Assert.Equal("{TemplateBinding IsReadOnly}", (string?)editor.Attribute("IsReadOnly"));
        Assert.Equal("False", (string?)editor.Attribute("AcceptsReturn"));
        Assert.Equal(
            "{TemplateBinding IsTextSearchEnabled}",
            (string?)editor.Attribute("InputMethod.IsInputMethodEnabled"));
        Assert.Equal(
            "{TemplateBinding SelectionBoxItemStringFormat}",
            (string?)contentSite.Attribute("ContentStringFormat"));
        Assert.Equal(
            "{TemplateBinding ItemTemplateSelector}",
            (string?)contentSite.Attribute("ContentTemplateSelector"));

        var editableTrigger = style
            .Descendants()
            .Single(element =>
                element.Name.LocalName == "Trigger"
                && (string?)element.Attribute("Property") == "IsEditable"
                && (string?)element.Attribute("Value") == "True");

        AssertTriggerSetter(editableTrigger, "ContentSite", "Visibility", "Collapsed");
        AssertTriggerSetter(editableTrigger, "PART_EditableTextBox", "Visibility", "Visible");
    }

    [Fact]
    public void ReadableHintsAndSidebarLabels_UseAccessibleSecondaryText()
    {
        var tokens = LoadXaml("Themes", "DesignTokens.xaml");
        var controls = LoadXaml("Themes", "Controls.xaml");
        var hintStyle = FindResource(controls, "UiHint");

        Assert.Equal(
            "{DynamicResource BrushTextSecondary}",
            StyleSetterValue(hintStyle, "Foreground"));
        AssertBrushColor(tokens, "BrushTextMuted", "#98A0B3");
        AssertBrushColor(tokens, "BrushSidebarMuted", "#667085");

        var foreground = BrushColor(tokens, "BrushSidebarMuted");
        var background = BrushColor(tokens, "BrushSidebarBg");
        Assert.True(
            ContrastRatio(foreground, background) >= 4.5,
            $"{foreground} on {background} must meet 4.5:1 text contrast.");
    }

    [Fact]
    public void SuccessButton_UsesWhiteReadableSuccessStates()
    {
        var tokens = LoadXaml("Themes", "DesignTokens.xaml");
        var controls = LoadXaml("Themes", "Controls.xaml");
        var style = FindResource(controls, "UiBtnSuccess");

        AssertBrushColor(tokens, "BrushSuccess", "#027A48");
        AssertBrushColor(tokens, "BrushSuccessHover", "#05603A");
        AssertBrushColor(tokens, "BrushSuccessPressed", "#054F31");
        Assert.Equal("{DynamicResource BrushSuccess}", StyleSetterValue(style, "Background"));
        Assert.Equal("{DynamicResource BrushTextOnAccent}", StyleSetterValue(style, "Foreground"));
        AssertStyleTriggerSetter(
            style,
            "IsMouseOver",
            "True",
            "ButtonBorder",
            "Background",
            "{DynamicResource BrushSuccessHover}");
        AssertStyleTriggerSetter(
            style,
            "IsPressed",
            "True",
            "ButtonBorder",
            "Background",
            "{DynamicResource BrushSuccessPressed}");
        Assert.True(ContrastRatio("#FFFFFF", "#027A48") >= 4.5);
    }

    [Fact]
    public void ScrollBars_KeepFourteenDipHitTargetsAndAccessibleThumbs()
    {
        var document = LoadXaml("Themes", "Controls.xaml");
        var style = document.Root!
            .Elements()
            .Single(element =>
                element.Name.LocalName == "Style"
                && (string?)element.Attribute("TargetType") == "ScrollBar"
                && element.Attribute(XamlNamespace + "Key") is null);

        Assert.Equal("14", StyleSetterValue(style, "Width"));
        Assert.Equal("14", StyleSetterValue(style, "MinWidth"));
        Assert.Equal("Transparent", StyleSetterValue(style, "Background"));

        var horizontalTrigger = style
            .Descendants()
            .Single(element =>
                element.Name.LocalName == "Trigger"
                && (string?)element.Attribute("Property") == "Orientation"
                && (string?)element.Attribute("Value") == "Horizontal");
        AssertTriggerSetter(horizontalTrigger, null, "Height", "14");
        AssertTriggerSetter(horizontalTrigger, null, "MinHeight", "14");

        var verticalThumb = FindResource(document, "UiVerticalScrollBarTemplate")
            .Descendants()
            .Single(element => (string?)element.Attribute(XamlNamespace + "Name") == "ScrollThumb");
        var horizontalThumb = FindResource(document, "UiHorizontalScrollBarTemplate")
            .Descendants()
            .Single(element => (string?)element.Attribute(XamlNamespace + "Name") == "ScrollThumb");

        Assert.Equal("{DynamicResource BrushTextSecondary}", (string?)verticalThumb.Attribute("Background"));
        Assert.Equal("28", (string?)verticalThumb.Attribute("MinHeight"));
        Assert.Equal("{DynamicResource BrushTextSecondary}", (string?)horizontalThumb.Attribute("Background"));
        Assert.Equal("28", (string?)horizontalThumb.Attribute("MinWidth"));
    }

    [Fact]
    public void CaptionButtons_AllowStylesToOwnReadableInteractiveForegrounds()
    {
        var document = LoadXaml("MainWindow.xaml");
        var baseStyle = FindResource(document, "CaptionBarButton");
        var closeStyle = FindResource(document, "CaptionCloseButton");
        var captionButtons = document
            .Descendants()
            .Where(element =>
                element.Name.LocalName == "Button"
                && ((string?)element.Attribute("Style"))?.Contains("Caption", StringComparison.Ordinal) == true)
            .ToArray();

        Assert.Equal(3, captionButtons.Length);
        Assert.All(captionButtons, button => Assert.Null(button.Attribute("Foreground")));
        Assert.Equal(
            "{StaticResource BrushTextSecondary}",
            StyleSetterValue(baseStyle, "Foreground"));
        AssertStyleTriggerSetter(
            baseStyle,
            "IsMouseOver",
            "True",
            null,
            "Foreground",
            "{StaticResource BrushTextPrimary}");
        AssertStyleTriggerSetter(
            baseStyle,
            "IsPressed",
            "True",
            null,
            "Foreground",
            "{StaticResource BrushAccentPressed}");
        AssertStyleTriggerSetter(
            baseStyle,
            "IsKeyboardFocused",
            "True",
            "bd",
            "BorderBrush",
            "{StaticResource BrushBorderFocus}");
        AssertStyleTriggerSetter(
            closeStyle,
            "IsMouseOver",
            "True",
            null,
            "Foreground",
            "{StaticResource BrushTextOnAccent}");
        AssertStyleTriggerSetter(
            closeStyle,
            "IsPressed",
            "True",
            "bd",
            "Background",
            "{StaticResource BrushDangerHover}");
        AssertStyleTriggerSetter(
            closeStyle,
            "IsPressed",
            "True",
            null,
            "Foreground",
            "{StaticResource BrushTextOnAccent}");
    }

    [Fact]
    public void NotesToolbarStyles_AreCompactAndDoNotInheritRegularButtons()
    {
        var document = LoadXaml("Views", "NotesView.xaml");
        var regular = FindResource(document, "ToolbarMiniBtn");
        var accent = FindResource(document, "ToolbarMiniAccent");

        Assert.Null(regular.Attribute("BasedOn"));
        Assert.Null(accent.Attribute("BasedOn"));
        Assert.Equal("28", StyleSetterValue(regular, "Height"));
        Assert.Equal("0", StyleSetterValue(regular, "MinHeight"));
        Assert.Equal("7,3", StyleSetterValue(regular, "Padding"));
        Assert.Equal("28", StyleSetterValue(accent, "Height"));
        Assert.Equal("0", StyleSetterValue(accent, "MinHeight"));
        Assert.Equal("10,3", StyleSetterValue(accent, "Padding"));

        AssertCompactToolbarTemplate(regular);
        AssertCompactToolbarTemplate(accent);
    }

    [Fact]
    public void NotesWorkspace_UsesContinuousColumnsWithoutNestedCards()
    {
        var document = LoadXaml("Views", "NotesView.xaml");

        var root = FindNamedElement(document, "NotesWorkspaceRoot");
        var library = FindNamedElement(document, "NotesLibraryPanel");
        var workspace = FindNamedElement(document, "DocumentWorkspacePanel");
        var inspector = FindNamedElement(document, "InspectorPanel");

        Assert.Equal("0", (string?)root.Attribute("Margin"));
        Assert.Equal("280", (string?)library.Attribute("Width"));
        Assert.Equal("0", (string?)library.Attribute("Margin"));
        Assert.Equal("0", (string?)library.Attribute("CornerRadius"));
        Assert.Equal("0,0,1,0", (string?)library.Attribute("BorderThickness"));
        Assert.Equal("0", (string?)workspace.Attribute("Margin"));
        Assert.Equal("0", (string?)workspace.Attribute("CornerRadius"));
        Assert.Equal("0", (string?)workspace.Attribute("BorderThickness"));
        Assert.Equal("Collapsed", (string?)inspector.Attribute("Visibility"));
        Assert.Equal("0", (string?)inspector.Attribute("Margin"));
        Assert.Equal("0", (string?)inspector.Attribute("CornerRadius"));
        Assert.Equal("1,0,0,0", (string?)inspector.Attribute("BorderThickness"));
    }

    [Fact]
    public void NotesWorkspace_UsesCompactContinuousEditorChrome()
    {
        var document = LoadXaml("Views", "NotesView.xaml");

        var titleBar = FindNamedElement(document, "DocumentTitleBar");
        var formattingBar = FindNamedElement(document, "EditorToolbarRow");
        var editorSurface = FindNamedElement(document, "ClassicEditorSurface");
        var previewSurface = FindNamedElement(document, "PreviewSurface");
        var liveSurface = FindNamedElement(document, "LiveEditorHost");

        Assert.Equal("40", (string?)titleBar.Attribute("Height"));
        Assert.Equal("32", (string?)formattingBar.Attribute("Height"));
        Assert.Equal("0", (string?)formattingBar.Attribute("Margin"));
        Assert.DoesNotContain(
            formattingBar.Descendants(),
            element => (string?)element.Attribute("Text") == "格式");
        Assert.All(
            new[] { editorSurface, previewSurface, liveSurface },
            surface =>
            {
                Assert.Equal("0", (string?)surface.Attribute("CornerRadius"));
                Assert.Equal("0", (string?)surface.Attribute("BorderThickness"));
            });
        Assert.NotNull(FindNamedElement(document, "InspectorToggleBtn"));
    }

    [Fact]
    public void NotesTree_UsesQuietSelectedRowAndKeepsRealRecentsCollapsible()
    {
        var document = LoadXaml("Views", "NotesView.xaml");
        var treeStyle = document
            .Descendants()
            .Single(element =>
                element.Name.LocalName == "Style"
                && (string?)element.Attribute("TargetType") == "TreeViewItem"
                && element.Attribute(XamlNamespace + "Key") is null);
        var selectedTrigger = treeStyle
            .Descendants()
            .Single(element =>
                element.Name.LocalName == "Trigger"
                && (string?)element.Attribute("Property") == "IsSelected"
                && (string?)element.Attribute("Value") == "True");

        AssertTriggerSetter(
            selectedTrigger,
            "NodeRow",
            "Background",
            "{StaticResource BrushSidebarActive}");
        Assert.NotNull(FindNamedElement(document, "RecentNotesExpander"));
        Assert.NotNull(FindNamedElement(document, "RecentNotesList"));
    }

    [Fact]
    public void NotesWorkspace_UsesOneCompactFormattingBarAndRetainsCommandsInMenus()
    {
        var document = LoadXaml("Views", "NotesView.xaml");

        var formattingBar = FindNamedElement(document, "EditorToolbarRow");
        var aiButton = FindNamedElement(document, "NoteAiRunBtn");
        var moreButton = FindNamedElement(document, "MoreActionsBtn");

        Assert.Equal("32", (string?)formattingBar.Attribute("Height"));
        Assert.Equal("{StaticResource ToolbarMiniAccent}", (string?)aiButton.Attribute("Style"));
        Assert.NotNull(moreButton);
        Assert.Contains(document.Descendants(), element =>
            (string?)element.Attribute("Click") == "ExportHtml_OnClick");
        Assert.Contains(document.Descendants(), element =>
            (string?)element.Attribute("Click") == "VersionHistory_OnClick");
        Assert.Contains(document.Descendants(), element =>
            (string?)element.Attribute("Click") == "Delete_OnClick");
    }

    [Fact]
    public void NotesWorkspace_BindsRealRecentsAndSupportsOutlineAndMenuHandlers()
    {
        var document = LoadXaml("Views", "NotesView.xaml");
        var codeBehind = File.ReadAllText(ProjectPath("Views", "NotesView.xaml.cs")).Replace("\r\n", "\n");

        Assert.Contains(document.Descendants(), element =>
            (string?)element.Attribute("Click") == "RecentNote_OnClick");
        Assert.Contains(document.Descendants(), element =>
            (string?)element.Attribute("Click") == "OutlineItem_OnClick");
        Assert.Contains(document.Descendants(), element =>
            (string?)element.Attribute("Click") == "AiAssistantAction_OnClick");
        Assert.Contains(document.Descendants(), element =>
            (string?)element.Attribute("Click") == "OpenContextMenu_OnClick");
        Assert.Contains("ObservableCollection<NoteFileInfo> _recentNotes", codeBehind);
        Assert.Contains("ObservableCollection<NoteOutlineEntry> _outlineItems", codeBehind);
        Assert.Contains("private void RecentNote_OnClick", codeBehind);
        Assert.Contains("private void OutlineItem_OnClick", codeBehind);
        Assert.Contains("private void AiAssistantAction_OnClick", codeBehind);
        Assert.Contains("private void OpenContextMenu_OnClick", codeBehind);
    }

    [Fact]
    public void NotesInspector_StartsHiddenAndRetainsToggleBehavior()
    {
        var codeBehind = File.ReadAllText(ProjectPath("Views", "NotesView.xaml.cs"))
            .Replace("\r\n", "\n");

        Assert.Contains("private bool _inspectorVisible = false;", codeBehind);
        Assert.Contains("private void ToggleInspector_OnClick", codeBehind);
        Assert.Contains("InspectorPanel.Visibility = Visibility.Visible;", codeBehind);
        Assert.Contains("InspectorPanel.Visibility = Visibility.Collapsed;", codeBehind);
    }

    [Fact]
    public void NotesTitleBarCommands_TargetTheCurrentlyOpenNote()
    {
        var codeBehind = File.ReadAllText(ProjectPath("Views", "NotesView.xaml.cs")).Replace("\r\n", "\n");

        Assert.Contains(
            "private void Rename_OnClick(object sender, RoutedEventArgs e)\n    {\n        if (_notes == null || string.IsNullOrEmpty(_currentPath)) return;\n        var currentPath = _currentPath;",
            codeBehind);
        Assert.Contains(
            "private void Delete_OnClick(object sender, RoutedEventArgs e)\n    {\n        if (_notes == null || string.IsNullOrEmpty(_currentPath)) return;\n        var currentPath = _currentPath;",
            codeBehind);
    }

    [Fact]
    public void CheckBoxAndTabItem_ExposeSeparateKeyboardFocusRings()
    {
        var document = LoadXaml("Themes", "Controls.xaml");
        var checkBoxStyle = FindImplicitStyle(document, "CheckBox");
        var tabItemStyle = FindImplicitStyle(document, "TabItem");

        Assert.Contains(
            checkBoxStyle.Descendants(),
            element => (string?)element.Attribute(XamlNamespace + "Name") == "CheckFocusRing");
        AssertStyleTriggerSetter(
            checkBoxStyle,
            "IsKeyboardFocused",
            "True",
            "CheckFocusRing",
            "BorderBrush",
            "{DynamicResource BrushBorderFocus}");

        Assert.Contains(
            tabItemStyle.Descendants(),
            element => (string?)element.Attribute(XamlNamespace + "Name") == "TabFocusRing");
        AssertStyleTriggerSetter(
            tabItemStyle,
            "IsKeyboardFocused",
            "True",
            "TabFocusRing",
            "BorderBrush",
            "{DynamicResource BrushBorderFocus}");
    }

    private static void AssertBrushColor(XDocument document, string key, string expectedColor)
    {
        var resource = FindResource(document, key);

        Assert.Equal(expectedColor, (string?)resource.Attribute("Color"));
    }

    private static XElement FindResource(XDocument document, string key) =>
        document
            .Descendants()
            .Single(element => (string?)element.Attribute(XamlNamespace + "Key") == key);

    private static XElement FindNamedElement(XDocument document, string name) =>
        document
            .Descendants()
            .Single(element => (string?)element.Attribute(XamlNamespace + "Name") == name);

    private static ResourceDictionary LoadSidebarExpanderResources()
    {
        var style = FindResource(LoadXaml("MainWindow.xaml"), "SidebarExpanderStyle");
        var dictionaryXaml = $$"""
            <ResourceDictionary xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                                xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                                xmlns:automation="clr-namespace:System.Windows.Automation;assembly=PresentationCore">
                <ResourceDictionary.MergedDictionaries>
                    <ResourceDictionary Source="pack://application:,,,/DanceMonkey;component/Themes/DesignTokens.xaml"/>
                </ResourceDictionary.MergedDictionaries>
                {{style}}
            </ResourceDictionary>
            """;

        return Assert.IsType<ResourceDictionary>(XamlReader.Parse(dictionaryXaml));
    }

    private static void RunOnStaThread(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                action();
            }
            catch (Exception exception)
            {
                failure = exception;
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();

        if (failure is not null)
            ExceptionDispatchInfo.Capture(failure).Throw();
    }

    private static bool[] InvokeSidebarState(
        System.Reflection.MethodInfo apply,
        object coordinator,
        bool collapsed,
        IReadOnlyList<bool> current) =>
        ((IEnumerable<bool>?)apply.Invoke(coordinator, [collapsed, current]))
            ?.ToArray()
        ?? throw new InvalidOperationException("Sidebar state coordinator returned no state.");

    private static XElement FindImplicitStyle(XDocument document, string targetType) =>
        document.Root!
            .Elements()
            .Single(element =>
                element.Name.LocalName == "Style"
                && (string?)element.Attribute("TargetType") == targetType
                && element.Attribute(XamlNamespace + "Key") is null);

    private static string BrushColor(XDocument document, string key) =>
        (string?)FindResource(document, key).Attribute("Color")
        ?? throw new InvalidDataException($"{key} must define a Color.");

    private static string? StyleSetterValue(XElement style, string property) =>
        style
            .Elements()
            .Single(element =>
                element.Name.LocalName == "Setter"
                && (string?)element.Attribute("Property") == property)
            .Attribute("Value")
            ?.Value;

    private static void AssertCompactToolbarTemplate(XElement style)
    {
        var template = style
            .Descendants()
            .Single(element => element.Name.LocalName == "ControlTemplate");

        Assert.Contains(
            template.Descendants(),
            element => (string?)element.Attribute(XamlNamespace + "Name") == "ButtonBorder");
        Assert.Contains(
            template.Descendants(),
            element => (string?)element.Attribute(XamlNamespace + "Name") == "FocusRing");

        Assert.All(
            new[] { "IsMouseOver", "IsPressed", "IsKeyboardFocused" },
            property => Assert.Contains(
                template.Descendants(),
                element => element.Name.LocalName == "Trigger"
                           && (string?)element.Attribute("Property") == property));
    }

    private static void AssertStyleTriggerSetter(
        XElement style,
        string triggerProperty,
        string triggerValue,
        string? targetName,
        string property,
        string expectedValue)
    {
        var trigger = style
            .Descendants()
            .Single(element =>
                element.Name.LocalName == "Trigger"
                && (string?)element.Attribute("Property") == triggerProperty
                && (string?)element.Attribute("Value") == triggerValue);

        AssertTriggerSetter(trigger, targetName, property, expectedValue);
    }

    private static void AssertTriggerSetter(
        XElement trigger,
        string? targetName,
        string property,
        string expectedValue)
    {
        var setter = trigger
            .Elements()
            .Single(element =>
                element.Name.LocalName == "Setter"
                && (string?)element.Attribute("TargetName") == targetName
                && (string?)element.Attribute("Property") == property);

        Assert.Equal(expectedValue, (string?)setter.Attribute("Value"));
    }

    private static double ContrastRatio(string foreground, string background)
    {
        var foregroundLuminance = RelativeLuminance(foreground);
        var backgroundLuminance = RelativeLuminance(background);
        var lighter = Math.Max(foregroundLuminance, backgroundLuminance);
        var darker = Math.Min(foregroundLuminance, backgroundLuminance);
        return (lighter + 0.05) / (darker + 0.05);
    }

    private static double RelativeLuminance(string color)
    {
        var hex = color.TrimStart('#');
        Assert.Equal(6, hex.Length);

        var red = Convert.ToInt32(hex[..2], 16) / 255d;
        var green = Convert.ToInt32(hex[2..4], 16) / 255d;
        var blue = Convert.ToInt32(hex[4..6], 16) / 255d;

        return 0.2126 * Linearize(red) + 0.7152 * Linearize(green) + 0.0722 * Linearize(blue);
    }

    private static double Linearize(double channel) =>
        channel <= 0.04045
            ? channel / 12.92
            : Math.Pow((channel + 0.055) / 1.055, 2.4);

    private static IEnumerable<string> ResourceKeys(XDocument document) =>
        document
            .Descendants()
            .Select(element => (string?)element.Attribute(XamlNamespace + "Key"))
            .Where(key => !string.IsNullOrWhiteSpace(key))
            .Select(key => key!);

    private static XDocument LoadXaml(params string[] relativePath) =>
        XDocument.Load(ProjectPath(relativePath), LoadOptions.PreserveWhitespace);

    private static string ProjectPath(params string[] relativePath) =>
        Path.Combine(FindSolutionRoot(), Path.Combine(relativePath));

    private static string FindSolutionRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);

        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "DesktopAssistant.sln")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException(
            $"Could not find DesktopAssistant.sln above {AppContext.BaseDirectory}.");
    }
}
