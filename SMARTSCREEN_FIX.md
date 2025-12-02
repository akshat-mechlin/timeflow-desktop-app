# Fixing Windows Defender SmartScreen Warning

## Quick Fix for Users

If you see the SmartScreen warning when installing Mechlin TimeFlow:

1. Click **"More info"** on the warning dialog
2. Click **"Run anyway"** button
3. The application will install and run normally

## Why This Happens

Windows Defender SmartScreen shows this warning because:
- The application is not code-signed with a trusted certificate
- This is a security feature to protect users from potentially harmful software
- It's common for new or small software publishers

## For Developers

To permanently fix this warning, you need to:

1. **Purchase a Code Signing Certificate** from a trusted Certificate Authority
2. **Configure code signing** in the build process
3. **Rebuild the application** with the certificate

See `CODE_SIGNING.md` for detailed instructions.

## Is the Application Safe?

Yes! The application is safe to use. The warning appears because:
- The app is not yet code-signed (common for new applications)
- Windows doesn't recognize the publisher yet
- This is a standard security measure

Once you click "Run anyway" the first time, Windows will remember your choice for future installations.


