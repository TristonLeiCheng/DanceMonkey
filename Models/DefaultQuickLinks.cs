namespace DesktopAssistant.Models;

/// <summary>
/// 内置默认快捷方式列表，来源：北京供应中心内联网门户。
/// 当用户 config.json 中 quickLinks 为空时自动填充，首次运行即可直接使用。
/// </summary>
public static class DefaultQuickLinks
{
    public static List<QuickLinkItem> Build() =>
    [
        // ── 公共服务 ──────────────────────────────────────────────
        new() { Name = "通讯录",                      Path = "https://bayergroup.sharepoint.com/sites/021012/BJ/SiteService/DocLib/Forms/Reception%20service.aspx",                  Category = "sharepoint", Group = "公共服务" },
        new() { Name = "CIMS UP跃",                  Path = "https://cims-up.bayer.cn/",                                                                                            Category = "web",        Group = "公共服务" },
        new() { Name = "中国IT导览",                  Path = "https://bayergroup.sharepoint.com/sites/ChinaITCommunication",                                                         Category = "sharepoint", Group = "公共服务" },
        new() { Name = "会议室列表",                  Path = "https://bayergroup.sharepoint.com/sites/021012/BJ/SiteService/DocLib/Forms/Meeting%20service.aspx",                   Category = "sharepoint", Group = "公共服务" },
        new() { Name = "班车",                        Path = "https://apps.powerapps.com/play/e/df502657-dcfb-4824-8754-89c173477118/a/727624a4-a10d-4ac2-9b6c-3ce7732e6da0?tenantId=fcb2b37b-5da0-466b-9b83-0014b67a7c78&source=teamsLinkUnfurling&hidenavbar=true", Category = "web", Group = "公共服务" },
        new() { Name = "工会",                        Path = "https://www.bhclaborunion.com.cn/bhc",                                                                                Category = "web",        Group = "公共服务" },
        new() { Name = "访客管理系统",                Path = "https://newvisitors.intranet.cnb/vms_web/order",                                                                      Category = "web",        Group = "公共服务" },
        new() { Name = "工作餐系统",                  Path = "https://apps.powerapps.com/play/e/df502657-dcfb-4824-8754-89c173477118/a/774977db-b5f6-4f59-a9a0-07f69c2c15ab?tenantId=fcb2b37b-5da0-466b-9b83-0014b67a7c78&source=portal&hidenavbar=true", Category = "web", Group = "公共服务" },
        new() { Name = "非工作时间入厂&订餐申请",     Path = "https://apps.powerapps.com/play/e/df502657-dcfb-4824-8754-89c173477118/a/42957528-9444-49cd-b30b-6e5813ef153e?tenantId=fcb2b37b-5da0-466b-9b83-0014b67a7c78", Category = "web", Group = "公共服务" },
        new() { Name = "门禁权限申请",                Path = "https://apps.powerapps.com/play/e/f9dcc569-b256-e0cd-b589-f210c7c5795b/a/57c5a8e5-a1f1-4b9f-a9a9-c8c0c5a80930?tenantId=fcb2b37b-5da0-466b-9b83-0014b67a7c78", Category = "web", Group = "公共服务" },
        new() { Name = "群发邮件组地址",              Path = "https://bayergroup.sharepoint.com/sites/021012/BJ/SitePages/Group-Email-Addresses---SCBJ.aspx",                      Category = "sharepoint", Group = "公共服务" },
        new() { Name = "公租房排名公示",              Path = "https://apps.powerapps.com/play/e/8dd1b106-2efd-e01b-8d61-9c86a3392a4e/a/4ce7babc-d850-4220-b818-a6e37339a3f7?tenantId=fcb2b37b-5da0-466b-9b83-0014b67a7c78", Category = "web", Group = "公共服务" },
        new() { Name = "想法收集-持续改进数字化",     Path = "https://bayergroup.sharepoint.com/sites/021012/BJ/SitePages/QR-Code-for-Idea-Collection.aspx",                       Category = "sharepoint", Group = "公共服务" },

        // ── 拜耳中国 ──────────────────────────────────────────────
        new() { Name = "拜耳内联网",                  Path = "https://bayernet.int.bayer.com/zh-cn/",                                                                               Category = "web",        Group = "拜耳中国" },
        new() { Name = "My Services",                 Path = "https://myservicesprod.launchpad.cfapps.eu20.hana.ondemand.com/site#Shell-home",                                      Category = "web",        Group = "拜耳中国" },
        new() { Name = "组织架构查询",                Path = "https://myservicesprod.launchpad.cfapps.eu20.hana.ondemand.com/site#GLSE_ORG_PLUS-display",                          Category = "web",        Group = "拜耳中国" },
        new() { Name = "微信内部企业号管理",          Path = "https://wechat.bayer.cn/index/",                                                                                     Category = "web",        Group = "拜耳中国" },
        new() { Name = "IT服务入口",                  Path = "https://bayersi.service-now.com/sp",                                                                                 Category = "web",        Group = "拜耳中国" },
        new() { Name = "Your-Docs",                   Path = "https://yd-awf.intranet.cnb",                                                                                        Category = "web",        Group = "拜耳中国" },
        new() { Name = "IT Service Now",              Path = "https://bayersi.service-now.com/",                                                                                    Category = "web",        Group = "拜耳中国" },
        new() { Name = "SmartDesk",                   Path = "https://bayer-s2p.topdesk.net/tas/public/ssp/",                                                                      Category = "web",        Group = "拜耳中国" },
        new() { Name = "SmartBuy",                    Path = "https://s1-eu.ariba.com/Buyer/Main/aw?awh=r&realm=bayer&dard=1",                                                     Category = "web",        Group = "拜耳中国" },
        new() { Name = "爱福利",                      Path = "https://www.jiafuhui.com/shop/bayer/index.htm",                                                                      Category = "web",        Group = "拜耳中国" },
        new() { Name = "Concur",                      Path = "http://go/concur",                                                                                                   Category = "web",        Group = "拜耳中国" },
        new() { Name = "携程商旅",                    Path = "https://ct.ctrip.com/pcsaml/SAML/AssertionConsumerService/Bayer",                                                    Category = "web",        Group = "拜耳中国" },
        new() { Name = "拜耳差旅门户",                Path = "https://new.bayernet.cnb/zh-cn/greater-china/home/services/mobility-portal",                                         Category = "web",        Group = "拜耳中国" },
        new() { Name = "eTrip",                       Path = "https://eworkflow.ap.bayer.cnb/login.jsp?action=logout",                                                             Category = "web",        Group = "拜耳中国" },
        new() { Name = "拜耳员工激励平台",            Path = "https://bayer.ecosaas.com/",                                                                                         Category = "web",        Group = "拜耳中国" },
        new() { Name = "北京侨福办公室",              Path = "https://bayergroup.sharepoint.com/sites/020856/004/001/BJ/default.aspx",                                             Category = "sharepoint", Group = "拜耳中国" },
        new() { Name = "CSRM",                        Path = "https://bayergroup.sharepoint.com/sites/csrm",                                                                       Category = "sharepoint", Group = "拜耳中国" },
        new() { Name = "Docusign",                    Path = "https://account.docusign.com/#/username",                                                                            Category = "web",        Group = "拜耳中国" },

        // ── 其他链接 ──────────────────────────────────────────────
        new() { Name = "谷歌",                        Path = "https://www.google.com",                                                                                             Category = "web",        Group = "其他链接" },
        new() { Name = "百度",                        Path = "https://www.baidu.com",                                                                                              Category = "web",        Group = "其他链接" },
        new() { Name = "拜耳翻译",                    Path = "https://translate.int.bayer.com/translation",                                                                        Category = "web",        Group = "其他链接" },
        new() { Name = "大文件传输",                  Path = "https://mytransfer-lev.bayer.biz/",                                                                                  Category = "web",        Group = "其他链接" },
        new() { Name = "Outlook网页版",               Path = "http://outlook.com/owa/bayergroup.mail.onmicrosoft.com",                                                             Category = "web",        Group = "其他链接" },
        new() { Name = "无线密码",                    Path = "https://inet-account-mgt.intranet.cnb/en",                                                                           Category = "web",        Group = "其他链接" },
        new() { Name = "Chat",                        Path = "https://chat.int.bayer.com/",                                                                                        Category = "web",        Group = "其他链接" },
        new() { Name = "知识库",                      Path = "https://bcnbejs0250/",                                                                                               Category = "web",        Group = "其他链接", Pinned = true },
        new() { Name = "USB权限申请",                 Path = "https://bayersi.service-now.com/sp?id=sc_cat_item&sys_id=1d2d3cb61b82f9507a9ba868b04bcbc0",                          Category = "web",        Group = "其他链接" },
        new() { Name = "SAP Password Reset Hub",      Path = "https://myservicesprod.launchpad.cfapps.eu20.hana.ondemand.com/site#1A_GW_PWR-display",                             Category = "web",        Group = "其他链接" },
        new() { Name = "特殊权限申请",                Path = "https://myaccess.microsoft.com/@bayergroup.onmicrosoft.com#/access-packages",                                        Category = "web",        Group = "其他链接" },
        new() { Name = "Delve",                       Path = "https://eur.delve.office.com/",                                                                                      Category = "web",        Group = "其他链接" },
        new() { Name = "科力普商城",                  Path = "https://www.colipu.com",                                                                                             Category = "web",        Group = "其他链接" },
        new() { Name = "离职申请",                    Path = "https://apps.powerapps.com/play/e/default-fcb2b37b-5da0-466b-9b83-0014b67a7c78/a/abf9b436-7a88-4874-9126-ee955b343dde?tenantId=fcb2b37b-5da0-466b-9b83-0014b67a7c78", Category = "web", Group = "其他链接" },

        // ── 制造 ─────────────────────────────────────────────────
        new() { Name = "MES D&Q&P系统",               Path = "https://citrix.bej.prod.cnb/vpn/index.html",                                                                         Category = "web",        Group = "制造" },
        new() { Name = "防火墙登录",                  Path = "https://byfwbejpeclx.ap.bayer.cnb:950",                                                                              Category = "web",        Group = "制造" },
        new() { Name = "MES BASE Showroom",            Path = "https://by-lea.de.bayer.cnb/Citrix/StoreSSOWeb/",                                                                    Category = "web",        Group = "制造" },
        new() { Name = "OEE数据库",                   Path = "https://hcnbejs0047.bayer.cnb/Login.aspx",                                                                          Category = "web",        Group = "制造" },
        new() { Name = "进入生产区许可登记表",         Path = "https://bayergroup.sharepoint.com/sites/021012/BJ/ProdAdmittance/default.aspx",                                      Category = "sharepoint", Group = "制造" },
        new() { Name = "库房管理系统",                Path = "https://wmsbj.bayer.biz/cgi-bin/web_om_bayer.exe#scr=iconhome",                                                     Category = "web",        Group = "制造" },
        new() { Name = "CIMS UP跃(制造)",             Path = "https://bcnbejs0102.bayer.cnb/Account/Login",                                                                        Category = "web",        Group = "制造" },

        // ── 质量 ─────────────────────────────────────────────────
        new() { Name = "IQMS",                        Path = "https://bayer-iqms.veevavault.com",                                                                                  Category = "web",        Group = "质量" },
        new() { Name = "LifeDoc",                     Path = "https://lifedoc.intranet.cnb/cara/index.jsp",                                                                        Category = "web",        Group = "质量" },
        new() { Name = "Valgenesis",                  Path = "https://vgeuprd.valgenesis.net/BAYER-PRD/login/login.aspx",                                                          Category = "web",        Group = "质量" },
        new() { Name = "Pharmdoss",                   Path = "https://pd-prod.intranet.cnb/cara/",                                                                                 Category = "web",        Group = "质量" },
        new() { Name = "偏差(DevCom)",                Path = "https://devacom.intranet.cnb/en_US/login/index.jsp",                                                                 Category = "web",        Group = "质量" },
        new() { Name = "GMP eLearning",               Path = "http://www.gmpx.de/logon.aspx",                                                                                     Category = "web",        Group = "质量" },

        // ── 工程 ─────────────────────────────────────────────────
        new() { Name = "Engineering Portal",          Path = "https://bayergroup.sharepoint.com/sites/EngineeringPortal/SitePages/Homepage.aspx",                                  Category = "sharepoint", Group = "工程" },
        new() { Name = "行政",                        Path = "https://bayergroup.sharepoint.com/sites/021012/BJ/SiteService/SitePages/Home.aspx",                                 Category = "sharepoint", Group = "工程" },
        new() { Name = "项目管理系统",                Path = "http://pms.bayer.cnb/",                                                                                              Category = "web",        Group = "工程" },
        new() { Name = "设施综合看板",                Path = "https://app.powerbi.com/reportEmbed?reportId=013b6ef9-9df4-47ab-967d-f20b99007504&autoAuth=true&ctid=fcb2b37b-5da0-466b-9b83-0014b67a7c78", Category = "web", Group = "工程" },
        new() { Name = "EDMS",                        Path = "https://bay08-sdx.intergraphsmartcloud.com/edmspop/",                                                                 Category = "web",        Group = "工程" },
        new() { Name = "IDNow权限管理",               Path = "https://bayer.identitynow.com/ui/d/mysailpoint",                                                                     Category = "web",        Group = "工程" },
        new() { Name = "User Info",                   Path = "https://userinfo.intranet.cnb",                                                                                      Category = "web",        Group = "工程" },
        new() { Name = "网络监控",                    Path = "https://bcnshgs0302.bayer.cnb/Orion/Login.aspx",                                                                     Category = "web",        Group = "工程" },

        // ── 物流 ─────────────────────────────────────────────────
        new() { Name = "仓库管理系统",                Path = "https://wmsbj.bayer.biz/cgi-bin/web_om_bayer.exe",                                                                   Category = "web",        Group = "物流" },
        new() { Name = "仓库管理系统PDA",             Path = "https://wmsbj.bayer.biz/cgi-bin/web_moi_bayer.exe",                                                                  Category = "web",        Group = "物流" },
        new() { Name = "Supply Chain KM",             Path = "http://sp-appl-bhc.bayer-ag.com/sites/220001/learning/SitePages/Home.aspx",                                          Category = "web",        Group = "物流" },

        // ── 战略卓越 ──────────────────────────────────────────────
        new() { Name = "改善Kaizen",                  Path = "https://bayergroup.sharepoint.com/sites/021012/BJ/Kaizen/default.aspx",                                              Category = "sharepoint", Group = "战略卓越" },
        new() { Name = "5S",                          Path = "https://bayergroup.sharepoint.com/sites/002630/SitePages/5S.aspx",                                                   Category = "sharepoint", Group = "战略卓越" },
        new() { Name = "问题解决卡流程PSS",           Path = "https://bcnbejs0102.bayer.cnb/ipmsdatainput/gembaactionlist",                                                        Category = "web",        Group = "战略卓越" },
        new() { Name = "改善建议收集",                Path = "https://bayergroup.sharepoint.com/sites/020075/SitePages/Home.aspx",                                                 Category = "sharepoint", Group = "战略卓越" },
        new() { Name = "访客信息库",                  Path = "https://bayergroup.sharepoint.com/sites/021012/BJ/SiteVisit/_layouts/15/viewlsts.aspx",                             Category = "sharepoint", Group = "战略卓越" },

        // ── 投资项目管理 ──────────────────────────────────────────
        new() { Name = "投资项目交付系统",            Path = "https://capexds.int.bayer.com/gateprocess",                                                                          Category = "web",        Group = "投资项目管理" },
        new() { Name = "中国在线规章制度",            Path = "https://chinaregulationonline.bayer.cnb/Regulation/MyRegulation",                                                    Category = "web",        Group = "投资项目管理" },
        new() { Name = "GRC 消防中断通知系统",        Path = "https://grcconnect.globalriskconsultants.com/ins/app/Main/Registry.aspx?q=0",                                        Category = "web",        Group = "投资项目管理" },
        new() { Name = "合同管理",                    Path = "http://sp-coll-bhc.ap.bayer.cnb/sites/200212/General_Services/Seal/SitePages/Contract_CN.aspx",                     Category = "web",        Group = "投资项目管理" },
        new() { Name = "北京市政务服务网",            Path = "http://banshi.beijing.gov.cn/newhall/villages.html",                                                                 Category = "web",        Group = "投资项目管理" },

        // ── 质量国家平台 ──────────────────────────────────────────
        new() { Name = "Dev@com",                     Path = "https://devacom.intranet.cnb/en_US/login/index.jsp",                                                                 Category = "web",        Group = "质量国家平台" },
        new() { Name = "AIDa",                        Path = "https://trackwise.bhc.cnb/Production/",                                                                              Category = "web",        Group = "质量国家平台" },
        new() { Name = "Dido",                        Path = "https://forms-app.prod.dido.int.bayer.com/?tenant=CQ01",                                                             Category = "web",        Group = "质量国家平台" },
        new() { Name = "国家药品监督管理局",          Path = "https://www.nmpa.gov.cn/",                                                                                          Category = "web",        Group = "质量国家平台" },
        new() { Name = "北京市市场监管理局",          Path = "http://scjgj.beijing.gov.cn/",                                                                                      Category = "web",        Group = "质量国家平台" },
    ];
}
