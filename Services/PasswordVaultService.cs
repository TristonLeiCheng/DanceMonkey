using System.Collections.ObjectModel;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

/// <summary>本地加密密码库（单文件，主密码解锁）。</summary>
public sealed class PasswordVaultService
{
    public const string DefaultGroupName = "常规";

    private static readonly JsonSerializerOptions JsonOpt = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    private byte[]? _key;
    private byte[]? _salt;
    private readonly ObservableCollection<PasswordVaultEntry> _entries = new();
    private readonly ObservableCollection<string> _groups = new();

    public string VaultFilePath { get; }

    public PasswordVaultService(string vaultFilePath)
    {
        VaultFilePath = vaultFilePath;
        Entries = new ReadOnlyObservableCollection<PasswordVaultEntry>(_entries);
        GroupNames = new ReadOnlyObservableCollection<string>(_groups);
    }

    public bool IsUnlocked => _key != null;

    public ReadOnlyObservableCollection<PasswordVaultEntry> Entries { get; }

    public ReadOnlyObservableCollection<string> GroupNames { get; }

    public bool VaultFileExists => File.Exists(VaultFilePath);

    public void CreateVault(string masterPassword)
    {
        if (string.IsNullOrEmpty(masterPassword))
            throw new ArgumentException("主密码不能为空。");

        _salt = RandomNumberGenerator.GetBytes(PasswordVaultCrypto.SaltSize);
        _key = PasswordVaultCrypto.DeriveKey(masterPassword, _salt);
        _entries.Clear();
        _groups.Clear();
        _groups.Add(DefaultGroupName);
        Persist();
    }

    public void Unlock(string masterPassword)
    {
        if (!VaultFileExists)
            throw new FileNotFoundException("密码库文件不存在。");

        var env = ReadEnvelope();
        _salt = Convert.FromBase64String(env.SaltBase64);
        var nonce = Convert.FromBase64String(env.NonceBase64);
        var cipher = Convert.FromBase64String(env.CiphertextBase64);
        var key = PasswordVaultCrypto.DeriveKey(masterPassword, _salt);
        byte[] plain;
        try
        {
            plain = PasswordVaultCrypto.Decrypt(cipher, key, nonce);
        }
        catch
        {
            CryptographicOperations.ZeroMemory(key);
            throw new UnauthorizedAccessException("主密码错误，或文件已损坏。");
        }

        ClearKeyMaterial();
        _key = key;

        var json = Encoding.UTF8.GetString(plain);
        var doc = JsonSerializer.Deserialize<PasswordVaultInnerDocument>(json, JsonOpt)
                  ?? new PasswordVaultInnerDocument();

        _entries.Clear();
        foreach (var e in doc.Entries)
            _entries.Add(e);

        MergeGroupsFromDocument(doc);
    }

    private void MergeGroupsFromDocument(PasswordVaultInnerDocument doc)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (doc.Groups != null)
        {
            foreach (var g in doc.Groups)
            {
                var t = (g ?? "").Trim();
                if (t.Length > 0)
                    names.Add(t);
            }
        }

        foreach (var e in _entries)
        {
            var t = (e.Group ?? "").Trim();
            if (t.Length > 0)
                names.Add(t);
        }

        if (names.Count == 0)
            names.Add(DefaultGroupName);

        _groups.Clear();
        foreach (var g in names.OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            _groups.Add(g);
    }

    public void Lock()
    {
        ClearKeyMaterial();
        _salt = null;
        _entries.Clear();
        _groups.Clear();
    }

    public void Save()
    {
        if (_key == null || _salt == null)
            throw new InvalidOperationException("未解锁。");
        Persist();
    }

    public void ChangeMasterPassword(string oldPassword, string newPassword)
    {
        if (_key == null || _salt == null)
            throw new InvalidOperationException("未解锁。");
        if (string.IsNullOrEmpty(newPassword))
            throw new ArgumentException("新主密码不能为空。");

        var verify = PasswordVaultCrypto.DeriveKey(oldPassword, _salt);
        if (!CryptographicOperations.FixedTimeEquals(verify, _key))
        {
            CryptographicOperations.ZeroMemory(verify);
            throw new UnauthorizedAccessException("当前主密码错误。");
        }

        CryptographicOperations.ZeroMemory(verify);
        _salt = RandomNumberGenerator.GetBytes(PasswordVaultCrypto.SaltSize);
        CryptographicOperations.ZeroMemory(_key);
        _key = PasswordVaultCrypto.DeriveKey(newPassword, _salt);
        Persist();
    }

    public void AddOrUpdate(PasswordVaultEntry entry)
    {
        if (_key == null)
            throw new InvalidOperationException("未解锁。");

        var g = string.IsNullOrWhiteSpace(entry.Group) ? DefaultGroupName : entry.Group.Trim();
        entry.Group = g;
        entry.SystemLevel = PasswordVaultEntry.NormalizeSystemLevel(entry.SystemLevel);
        EnsureGroupExists(g);

        for (var i = 0; i < _entries.Count; i++)
        {
            if (_entries[i].Id == entry.Id)
            {
                _entries[i] = entry;
                return;
            }
        }

        _entries.Add(entry);
    }

    public void Remove(string id)
    {
        if (_key == null)
            return;
        for (var i = _entries.Count - 1; i >= 0; i--)
        {
            if (_entries[i].Id == id)
                _entries.RemoveAt(i);
        }
    }

    public void EnsureGroupExists(string groupName)
    {
        if (_key == null || string.IsNullOrWhiteSpace(groupName))
            return;
        var t = groupName.Trim();
        if (_groups.Any(x => string.Equals(x, t, StringComparison.OrdinalIgnoreCase)))
            return;
        InsertGroupSorted(t);
    }

    public void AddGroup(string name)
    {
        if (_key == null)
            throw new InvalidOperationException("未解锁。");
        var t = (name ?? "").Trim();
        if (string.IsNullOrEmpty(t))
            throw new ArgumentException("分组名称不能为空。");
        if (_groups.Any(x => string.Equals(x, t, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("已存在同名分组。");
        InsertGroupSorted(t);
        Persist();
    }

    public void RenameGroup(string oldName, string newName)
    {
        if (_key == null)
            throw new InvalidOperationException("未解锁。");
        var o = (oldName ?? "").Trim();
        var n = (newName ?? "").Trim();
        if (string.IsNullOrEmpty(o) || string.IsNullOrEmpty(n))
            throw new ArgumentException("分组名称不能为空。");
        if (string.Equals(o, n, StringComparison.OrdinalIgnoreCase))
            return;
        if (_groups.Any(x => string.Equals(x, n, StringComparison.OrdinalIgnoreCase) && !string.Equals(x, o, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("已存在同名分组。");

        var idx = -1;
        for (var i = 0; i < _groups.Count; i++)
        {
            if (string.Equals(_groups[i], o, StringComparison.OrdinalIgnoreCase))
            {
                idx = i;
                break;
            }
        }

        if (idx < 0)
            throw new InvalidOperationException("找不到分组。");

        _groups.RemoveAt(idx);
        InsertGroupSorted(n);

        foreach (var e in _entries)
        {
            if (string.Equals(e.Group, o, StringComparison.OrdinalIgnoreCase))
                e.Group = n;
        }

        Persist();
    }

    public void RemoveGroup(string name)
    {
        if (_key == null)
            throw new InvalidOperationException("未解锁。");
        if (_groups.Count <= 1)
            throw new InvalidOperationException("至少保留一个分组。");

        var target = (name ?? "").Trim();
        if (string.IsNullOrEmpty(target))
            return;

        var fallback = _groups.FirstOrDefault(g => !string.Equals(g, target, StringComparison.OrdinalIgnoreCase))
                       ?? DefaultGroupName;

        for (var i = _groups.Count - 1; i >= 0; i--)
        {
            if (string.Equals(_groups[i], target, StringComparison.OrdinalIgnoreCase))
            {
                _groups.RemoveAt(i);
                break;
            }
        }

        foreach (var e in _entries)
        {
            if (string.Equals(e.Group, target, StringComparison.OrdinalIgnoreCase))
                e.Group = fallback;
        }

        Persist();
    }

    private void InsertGroupSorted(string name)
    {
        var list = _groups.ToList();
        list.Add(name);
        list.Sort(StringComparer.OrdinalIgnoreCase);
        _groups.Clear();
        foreach (var g in list)
            _groups.Add(g);
    }

    private void Persist()
    {
        if (_key == null || _salt == null)
            throw new InvalidOperationException("未解锁。");

        var inner = new PasswordVaultInnerDocument
        {
            Groups = _groups.ToList(),
            Entries = _entries.ToList()
        };
        var json = JsonSerializer.Serialize(inner, JsonOpt);
        var plain = Encoding.UTF8.GetBytes(json);
        var (nonce, cipher) = PasswordVaultCrypto.Encrypt(plain, _key);

        var env = new PasswordVaultEnvelope
        {
            Version = 1,
            SaltBase64 = Convert.ToBase64String(_salt),
            NonceBase64 = Convert.ToBase64String(nonce),
            CiphertextBase64 = Convert.ToBase64String(cipher)
        };
        WriteEnvelope(env);
    }

    private void ClearKeyMaterial()
    {
        if (_key != null)
            CryptographicOperations.ZeroMemory(_key);
        _key = null;
    }

    private PasswordVaultEnvelope ReadEnvelope()
    {
        var text = File.ReadAllText(VaultFilePath, Encoding.UTF8);
        return JsonSerializer.Deserialize<PasswordVaultEnvelope>(text, JsonOpt)
               ?? throw new InvalidDataException("密码库格式无效。");
    }

    private void WriteEnvelope(PasswordVaultEnvelope env)
    {
        var text = JsonSerializer.Serialize(env, JsonOpt);
        var dir = Path.GetDirectoryName(VaultFilePath);
        if (!string.IsNullOrEmpty(dir))
            Directory.CreateDirectory(dir);
        var tmp = VaultFilePath + ".tmp";
        File.WriteAllText(tmp, text, new UTF8Encoding(false));
        if (File.Exists(VaultFilePath))
            File.Replace(tmp, VaultFilePath, VaultFilePath + ".bak", ignoreMetadataErrors: true);
        else
            File.Move(tmp, VaultFilePath);
    }
}
