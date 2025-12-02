# Code Signing for Windows

## Problem

Windows Defender SmartScreen shows a warning because the application is not code-signed. This is a security feature in Windows.

## Solutions

### Option 1: Purchase a Code Signing Certificate (Recommended for Production)

To properly resolve this, you need to purchase a code signing certificate from a trusted Certificate Authority (CA):

**Recommended Providers:**
- **DigiCert** - ~$200-400/year (most trusted)
- **Sectigo (formerly Comodo)** - ~$200-300/year
- **GlobalSign** - ~$200-300/year
- **SSL.com** - ~$200/year

**Steps:**
1. Purchase a code signing certificate
2. Complete identity verification (required by CA)
3. Download the certificate (.pfx file)
4. Configure in `package.json` (see below)

### Option 2: Use a Self-Signed Certificate (For Testing Only)

Self-signed certificates will still show a warning, but can be used for internal testing.

**Create a self-signed certificate:**
```powershell
# Run as Administrator
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Mechlin Technology" -CertStoreLocation Cert:\CurrentUser\My -KeyUsage DigitalSignature -FriendlyName "Mechlin TimeFlow Code Signing"
Export-PfxCertificate -Cert $cert -FilePath "code-signing-cert.pfx" -Password (ConvertTo-SecureString -String "YourPassword" -Force -AsPlainText)
```

### Option 3: User Instructions (Temporary Workaround)

For users who encounter the warning, they can:

1. Click "More info"
2. Click "Run anyway"

**Note:** This is not ideal for production distribution.

## Configuration

### If You Have a Code Signing Certificate

1. Place your certificate file (`.pfx`) in the project root or a secure location
2. Update `package.json` with certificate path:

```json
"win": {
  "certificateFile": "path/to/your/certificate.pfx",
  "certificatePassword": "your-certificate-password",
  "signingHashAlgorithms": ["sha256"],
  "signDlls": true
}
```

3. Set environment variables (optional, for security):
```bash
set WIN_CSC_LINK=path/to/your/certificate.pfx
set WIN_CSC_KEY_PASSWORD=your-certificate-password
```

4. Build with code signing enabled:
```bash
set CSC_IDENTITY_AUTO_DISCOVERY=true
npm run build:win
```

## Current Status

The application is currently built **without code signing** (`CSC_IDENTITY_AUTO_DISCOVERY=false`), which is why Windows shows the SmartScreen warning.

## Best Practices

1. **For Production:** Always use a certificate from a trusted CA
2. **For Internal Testing:** Self-signed certificates are acceptable
3. **For Distribution:** Code signing builds trust and reduces security warnings
4. **Security:** Never commit certificate files or passwords to version control

## Additional Resources

- [Electron Builder Code Signing Documentation](https://www.electron.build/code-signing)
- [Windows Code Signing Guide](https://docs.microsoft.com/en-us/windows/win32/seccrypto/cryptography-tools)

