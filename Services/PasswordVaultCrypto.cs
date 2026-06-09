using System.Security.Cryptography;
using System.Text;

namespace DesktopAssistant.Services;

/// <summary>主密码派生 + AES-256-GCM 封装。</summary>
public static class PasswordVaultCrypto
{
    public const int SaltSize = 32;
    public const int NonceSize = 12;
    public const int TagSize = 16;
    public const int KeySize = 32;
    public const int Pbkdf2Iterations = 210_000;

    public static byte[] DeriveKey(string masterPassword, byte[] salt)
    {
        using var pbkdf2 = new Rfc2898DeriveBytes(
            Encoding.UTF8.GetBytes(masterPassword),
            salt,
            Pbkdf2Iterations,
            HashAlgorithmName.SHA256);
        return pbkdf2.GetBytes(KeySize);
    }

    public static (byte[] Nonce, byte[] CipherWithTag) Encrypt(byte[] plainUtf8, byte[] key)
    {
        var nonce = RandomNumberGenerator.GetBytes(NonceSize);
        var cipher = new byte[plainUtf8.Length];
        var tag = new byte[TagSize];
        using (var aes = new AesGcm(key, TagSize))
        {
            aes.Encrypt(nonce, plainUtf8, cipher, tag);
        }

        var combined = new byte[cipher.Length + TagSize];
        Buffer.BlockCopy(cipher, 0, combined, 0, cipher.Length);
        Buffer.BlockCopy(tag, 0, combined, cipher.Length, TagSize);
        return (nonce, combined);
    }

    public static byte[] Decrypt(byte[] cipherWithTag, byte[] key, byte[] nonce)
    {
        if (cipherWithTag.Length < TagSize)
            throw new InvalidDataException("密文无效。");

        var cipherLen = cipherWithTag.Length - TagSize;
        var cipher = new byte[cipherLen];
        var tag = new byte[TagSize];
        Buffer.BlockCopy(cipherWithTag, 0, cipher, 0, cipherLen);
        Buffer.BlockCopy(cipherWithTag, cipherLen, tag, 0, TagSize);

        var plain = new byte[cipherLen];
        using var aes = new AesGcm(key, TagSize);
        aes.Decrypt(nonce, cipher, tag, plain);
        return plain;
    }
}
