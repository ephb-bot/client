# iOS Signing & CI Setup Guide

This guide walks through setting up Apple Developer credentials for building
and distributing the Keybase iOS app from CI (GitHub Actions).

## Prerequisites

- An Apple Developer account (paid, $99/year)
- Access to the GitHub repo settings (for adding secrets)

## 1. Register App Identifiers

Go to [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list).

### Main App

1. Click "+" -> App IDs -> App
2. Description: `Keybase`
3. Bundle ID (Explicit): `com.vrtxlabs.keybase`
4. Enable these capabilities:
   - App Groups
   - Associated Domains
   - Data Protection
   - Push Notifications
5. Continue -> Register

### Share Extension

1. Click "+" -> App IDs -> App
2. Description: `KeybaseShare`
3. Bundle ID (Explicit): `com.vrtxlabs.keybase.KeybaseShare`
4. Enable these capabilities:
   - App Groups
5. Continue -> Register

## 2. Create App Group

1. In the Identifiers list, click "+" -> App Groups
2. Description: `Keybase`
3. Identifier: `group.com.vrtxlabs.keybase`
4. Continue -> Register

### Assign the group to both App IDs

1. Go back to Identifiers -> click `com.vrtxlabs.keybase`
2. Scroll to App Groups -> Configure -> check `group.com.vrtxlabs.keybase` -> Save
3. Repeat for `com.vrtxlabs.keybase.KeybaseShare`

## 3. Create a Distribution Certificate

If you already have an Apple Distribution certificate, skip to step 4.

1. Go to Certificates -> click "+"
2. Select "Apple Distribution"
3. Follow the CSR (Certificate Signing Request) instructions:
   - Open Keychain Access on your Mac
   - Keychain Access -> Certificate Assistant -> Request a Certificate From a Certificate Authority
   - Enter your email, select "Saved to disk"
   - Upload the `.certSigningRequest` file
4. Download and double-click the `.cer` to install it in your Keychain

## 4. Export the Certificate as .p12

1. Open Keychain Access -> login keychain -> My Certificates
2. Find your "Apple Distribution: Your Name (TEAM_ID)" certificate
3. Right-click -> Export -> save as `.p12`
4. Choose a password (remember it for the next step)
5. Base64-encode it:

```bash
base64 -i ~/Desktop/Certificates.p12 | pbcopy
```

## 5. Create Provisioning Profiles

Go to [Profiles](https://developer.apple.com/account/resources/profiles/list).

### Main App Profile

1. Click "+" -> App Store Distribution (for TestFlight) or Ad Hoc (for sideloading)
2. Select App ID: `com.vrtxlabs.keybase`
3. Select your Distribution Certificate
4. (Ad Hoc only) Select test devices
5. Name: `Keybase Distribution`
6. Generate -> Download

### Share Extension Profile

1. Click "+" -> same type as above
2. Select App ID: `com.vrtxlabs.keybase.KeybaseShare`
3. Select the same Distribution Certificate
4. Name: `KeybaseShare Distribution`
5. Generate -> Download

### Base64-encode the profiles

```bash
base64 -i Keybase_Distribution.mobileprovision | pbcopy
# paste as PROVISIONING_PROFILE

base64 -i KeybaseShare_Distribution.mobileprovision | pbcopy
# paste as PROVISIONING_PROFILE_SHARE_EXTENSION
```

## 6. App Store Connect API Key (for TestFlight)

This is optional - only needed if you want CI to auto-upload to TestFlight.

1. Go to [App Store Connect](https://appstoreconnect.apple.com/) -> Users and Access -> Integrations -> App Store Connect API
2. Click "+" to generate a new key
3. Name: `CI` (or anything)
4. Role: App Manager or Admin
5. Note the **Key ID** and **Issuer ID** shown on the page
6. Download the `.p8` key file (one-time download!)

```bash
base64 -i ~/Downloads/AuthKey_XXXXXXXX.p8 | pbcopy
```

## 7. Add GitHub Secrets

Go to [repo settings -> Secrets and variables -> Actions](https://github.com/ephb-bot/keybase-client/settings/secrets/actions).

Add these secrets:

| Secret Name | Value |
|------------|-------|
| `SIGNING_CERTIFICATE_P12` | Base64 of the .p12 file |
| `SIGNING_CERTIFICATE_PASSWORD` | The .p12 export password (plain text) |
| `PROVISIONING_PROFILE` | Base64 of the main app .mobileprovision |
| `PROVISIONING_PROFILE_SHARE_EXTENSION` | Base64 of the share extension .mobileprovision |
| `APP_STORE_CONNECT_KEY_ID` | Key ID string (optional, for TestFlight) |
| `APP_STORE_CONNECT_ISSUER_ID` | Issuer ID UUID (optional, for TestFlight) |
| `APP_STORE_CONNECT_KEY` | Base64 of the .p8 file (optional, for TestFlight) |

## 8. Capabilities Reference

### Why these specific capabilities?

| Capability | Reason | Used By |
|-----------|--------|---------|
| App Groups | Shared data container between app and share extension | `Fs.swift`, entitlements |
| Associated Domains | Universal links for `keybase.io` (won't fully work without domain control, but entitlement must match for code signing) | entitlements |
| Data Protection | `NSFileProtectionComplete` - encrypts files when device is locked | entitlements |
| Push Notifications | Message and chat notifications | `AppDelegate.swift`, entitlements |

### Background Modes (Info.plist, not portal capabilities)

These are configured in `Info.plist` under `UIBackgroundModes`, not as App ID capabilities:

- `fetch` - background data sync
- `location` - location sharing
- `remote-notification` - silent push notifications
- `audio` - background audio playback, Now Playing controls, AirPods gestures

### What about the keybase:// URL scheme?

The `keybase://` custom URL scheme is registered in `Info.plist` (not as a portal capability).
It works without any server-side configuration. Deep links like
`keybase://chat/team#channel?record=1` use this scheme.
