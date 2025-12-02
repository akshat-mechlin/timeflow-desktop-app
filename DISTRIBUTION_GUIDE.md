# Distribution Guide for Mechlin TimeFlow

This guide is for administrators and developers who need to distribute Mechlin TimeFlow to multiple devices.

## Build Artifacts

After building, you'll find the following files in the `release/` directory:

### Windows Installer
- **File:** `Mechlin TimeFlow Setup 1.2.0.exe`
- **Type:** NSIS Installer
- **Architecture:** x64 and ia32 (both included)
- **Size:** ~150-200 MB
- **Use Case:** Standard installation with Start Menu and desktop shortcuts

### Portable Version
- **File:** `Mechlin TimeFlow 1.2.0.exe`
- **Type:** Portable executable
- **Architecture:** x64 only
- **Size:** ~150 MB
- **Use Case:** No installation required, runs from any location

### Unpacked Application
- **Directory:** `release/win-unpacked/` or `release/win-ia32-unpacked/`
- **Type:** Unpacked application files
- **Use Case:** Advanced deployment, custom packaging

---

## Distribution Methods

### 1. Direct Distribution

#### Email Distribution
- **Pros:** Simple, direct
- **Cons:** File size limits, security concerns
- **Steps:**
  1. Attach installer to email
  2. Send to users
  3. Users download and install

#### Cloud Storage
- **Services:** OneDrive, Google Drive, Dropbox, SharePoint
- **Pros:** Easy sharing, version control
- **Cons:** Requires cloud access
- **Steps:**
  1. Upload installer to cloud storage
  2. Share link with users
  3. Users download and install

#### Network Share
- **Pros:** Fast, centralized
- **Cons:** Requires network access
- **Steps:**
  1. Place installer on network share
  2. Share path: `\\server\share\Mechlin TimeFlow Setup 1.2.0.exe`
  3. Users access and install

### 2. Enterprise Deployment

#### Group Policy (Active Directory)
1. **Create Software Package:**
   ```
   - Create a shared folder: \\domain\software\MechlinTimeFlow\
   - Copy installer to: \\domain\software\MechlinTimeFlow\Mechlin TimeFlow Setup 1.2.0.exe
   ```

2. **Create GPO:**
   - Open Group Policy Management
   - Create new GPO: "Deploy Mechlin TimeFlow"
   - Navigate to: Computer Configuration → Policies → Software Settings → Software Installation
   - Right-click → New → Package
   - Select the installer file
   - Choose "Assigned" or "Published"

3. **Link GPO:**
   - Link to appropriate OU
   - Users/computers will receive the software

#### Microsoft Intune
1. **Prepare Package:**
   - Create `.intunewin` file using Microsoft Win32 Content Prep Tool
   - Or use Intune Win32 App Packaging Tool

2. **Upload to Intune:**
   - Go to Microsoft Endpoint Manager
   - Apps → Windows → Add → Windows app (Win32)
   - Upload the package
   - Configure installation and detection rules

3. **Assign:**
   - Assign to user groups or device groups
   - Set installation behavior (required/available)

#### SCCM (System Center Configuration Manager)
1. **Create Application:**
   - Open SCCM Console
   - Software Library → Application Management → Applications
   - Create Application → Manually specify
   - Add deployment type (MSI or Script)

2. **Deploy:**
   - Create deployment
   - Target collection
   - Set deployment settings

#### Chocolatey (Package Manager)
1. **Create Package:**
   ```powershell
   choco new MechlinTimeFlow
   # Edit .nuspec and tools\chocolateyinstall.ps1
   ```

2. **Package:**
   ```powershell
   choco pack
   ```

3. **Deploy:**
   ```powershell
   choco install MechlinTimeFlow -y
   ```

### 3. USB/Removable Media

1. **Prepare USB:**
   - Format USB drive (FAT32 or NTFS)
   - Copy installer to USB
   - Optionally create `README.txt` with instructions

2. **Distribute:**
   - Provide USB to users
   - Users run installer from USB

---

## Pre-Installation Checklist

Before distributing, ensure:

- [ ] Application is tested on target Windows versions
- [ ] Supabase credentials are configured (hardcoded in `renderer.js`)
- [ ] Database schema is set up (see [DATABASE_SETUP.md](./DATABASE_SETUP.md))
- [ ] Azure SSO is configured (if using, see [AZURE_SSO_SETUP.md](./AZURE_SSO_SETUP.md))
- [ ] Users have Supabase accounts created
- [ ] Users are assigned to projects in Supabase
- [ ] Storage buckets are configured in Supabase
- [ ] Documentation is available for users

---

## Installation Requirements

### User Requirements
- Windows 10/11 (64-bit recommended)
- Administrator rights (for installation)
- Internet connection
- Camera access (optional, for camera capture)

### System Requirements
- 4 GB RAM minimum
- 500 MB free disk space
- .NET Framework (usually pre-installed on Windows 10/11)

---

## Post-Installation

### User Onboarding
1. **Send Welcome Email:**
   - Installation instructions
   - Login credentials (if provided)
   - Link to [SETUP_GUIDE.md](./SETUP_GUIDE.md)

2. **Provide Support:**
   - IT helpdesk contact
   - Documentation links
   - Training materials (if available)

### Verification
- [ ] Users can launch application
- [ ] Users can login
- [ ] Users can select projects/tasks
- [ ] Time tracking works
- [ ] Screenshots are captured
- [ ] Data syncs to Supabase

---

## Updating the Application

### Manual Update Process
1. Build new version
2. Distribute new installer
3. Users uninstall old version
4. Users install new version

### Automated Update (Future)
- Consider implementing auto-update using `electron-updater`
- Requires update server or GitHub releases

---

## Security Considerations

### Code Signing
- **Current Status:** Not code-signed (shows SmartScreen warning)
- **Recommendation:** Purchase code signing certificate for production
- **See:** [CODE_SIGNING.md](./CODE_SIGNING.md)

### Antivirus Whitelisting
- Add application to antivirus exclusions
- Whitelist installer file
- Whitelist application directory

### Network Requirements
- Allow connections to Supabase: `*.supabase.co`
- Allow connections to Azure SSO: `timeflow.mechlintech.com`
- Allow localhost:5174 (for OAuth callback)

---

## Version Management

### Version Numbering
- Format: `MAJOR.MINOR.PATCH` (e.g., 1.2.0)
- Current: 1.2.0
- Update in `package.json` before building

### Release Notes
Create a `CHANGELOG.md` or release notes document:
- New features
- Bug fixes
- Known issues
- Migration notes (if any)

---

## Troubleshooting Distribution

### Issue: Users Can't Download
- **Solution:** Check file permissions on share/cloud
- **Solution:** Verify file size limits
- **Solution:** Check network connectivity

### Issue: Installation Fails
- **Solution:** Ensure users have admin rights
- **Solution:** Check antivirus isn't blocking
- **Solution:** Verify Windows version compatibility

### Issue: SmartScreen Warning
- **Solution:** Provide instructions (see [SMARTSCREEN_FIX.md](./SMARTSCREEN_FIX.md))
- **Solution:** Purchase code signing certificate (long-term)

---

## Best Practices

1. **Test First:** Always test on a few devices before wide distribution
2. **Documentation:** Provide clear installation instructions
3. **Support:** Have IT support ready for issues
4. **Version Control:** Keep track of which version is deployed where
5. **Backup:** Keep installer files in multiple locations
6. **Security:** Use secure distribution channels
7. **Communication:** Notify users before deployment

---

## Quick Distribution Checklist

- [ ] Build application (`npm run build:win`)
- [ ] Test installer on clean Windows machine
- [ ] Verify Supabase connectivity
- [ ] Prepare distribution method
- [ ] Create user documentation
- [ ] Notify users of deployment
- [ ] Distribute installer
- [ ] Monitor for issues
- [ ] Provide support

---

## Support Resources

- **Setup Guide:** [SETUP_GUIDE.md](./SETUP_GUIDE.md)
- **Troubleshooting:** [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
- **Database Setup:** [DATABASE_SETUP.md](./DATABASE_SETUP.md)
- **Azure SSO:** [AZURE_SSO_SETUP.md](./AZURE_SSO_SETUP.md)
- **Code Signing:** [CODE_SIGNING.md](./CODE_SIGNING.md)

---

**Version:** 1.2.0  
**Last Updated:** 2024

