using System.Drawing;
using System.IO;
using System.Windows;

namespace DesktopAssistant;

/// <summary>从嵌入资源创建 WinForms 托盘可用的 <see cref="Icon"/>。</summary>
public static class TrayIconHelper
{
    /// <summary>从 pack URI 指向的 ICO 资源创建图标（与 <see cref="Window.Icon"/> 使用同一嵌入文件）。</summary>
    public static Icon? TryCreateIconFromPackIco(Uri packUri)
    {
        try
        {
            var info = Application.GetResourceStream(packUri);
            if (info?.Stream is null)
                return null;
            using (info.Stream)
            {
                using var ms = new MemoryStream();
                info.Stream.CopyTo(ms);
                ms.Position = 0;
                return new Icon(ms);
            }
        }
        catch
        {
            return null;
        }
    }
}
