# Windows Signing Guide

This guide explains how to set up Windows code signing for `haven-office` using:

- `electron-builder`
- GitHub Actions
- Azure Artifact Signing / Trusted Signing

For this repository, this is the preferred path over a local `.pfx` file because it avoids storing an exportable private key in GitHub secrets.

## Scope

This guide covers:

- creating the Azure Artifact Signing resources
- creating the Microsoft Entra app registration used by CI
- assigning the signing role to that app
- collecting the exact credentials this repo needs
- storing them as GitHub Actions secrets
- wiring `electron-builder` and the Windows release job
- verifying that the produced `.exe` files are signed

This guide does not cover:

- EV USB-token signing
- Microsoft Store / AppX packaging
- shipping Windows ARM64

## Naming Note

Microsoft now documents the service as **Artifact Signing**. `electron-builder` still exposes the configuration as `win.azureSignOptions` and documents it under **Azure Trusted Signing**.

Treat those as the same integration path for practical purposes.

## What Credentials You Need

You need two groups of values.

### Azure signing resource values

These describe the Artifact Signing account and certificate profile:

- `WINDOWS_SIGNING_ENDPOINT`
- `WINDOWS_SIGNING_ACCOUNT_NAME`
- `WINDOWS_SIGNING_CERT_PROFILE`
- `WINDOWS_SIGNING_PUBLISHER_NAME`

### Microsoft Entra service principal values

These let GitHub Actions authenticate to Azure:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`

## Recommended Secret Storage

Store these as **environment secrets** on the GitHub `release` environment, not as plain repository secrets.

That matches the repo's existing release workflow pattern for Apple credentials and lets you gate access with required reviewers if needed.

## Prerequisites

You need:

- an Azure subscription
- permission to create Azure resources in the target subscription or resource group
- permission to create Microsoft Entra app registrations
- permission to assign Azure RBAC roles
- admin access to this GitHub repository if you will add environment secrets

## Step 1: Create The Artifact Signing Account

First register the Azure resource provider:

```bash
az login
az account set -s <SUBSCRIPTION_ID>
az provider register --namespace Microsoft.CodeSigning
az provider show --namespace Microsoft.CodeSigning
az extension add --name artifact-signing
```

Then create the Artifact Signing account in the Azure portal or with Azure CLI.

When choosing names, keep them stable and boring. A good pattern is:

- account name: `havenco-signing`
- certificate profile: `haven-office`

Write these down as you create them:

- subscription ID
- resource group name
- Artifact Signing account name
- certificate profile name
- endpoint URL

## Step 2: Complete Identity Validation

In the Azure portal:

1. Open the Artifact Signing account.
2. Open `Identity validations`.
3. Create the required identity validation.
4. Finish Microsoft's verification flow.

For a public-trust certificate, this is the step that proves the legal identity behind the publisher.

The exact workflow depends on whether you are validating as:

- an organization
- a DBA
- an individual developer

Do not continue wiring CI until identity validation is approved and the certificate profile is usable.

## Step 3: Create The Certificate Profile

In the same Artifact Signing account:

1. Open `Certificate profiles`.
2. Create a profile.
3. Choose the public-trust profile type appropriate for your release.

Write down:

- certificate profile name
- the publisher common name shown for the certificate

That publisher common name must match `publisherName` in `electron-builder`.

Example:

```text
Publisher name: havenCo
```

If Azure shows a legal entity name instead, use that exact string. Do not normalize it yourself.

## Step 4: Create The Microsoft Entra App Registration For CI

This app registration is what GitHub Actions will use to authenticate to Azure.

In the Microsoft Entra admin center:

1. Go to `Entra ID > App registrations`.
2. Click `New registration`.
3. Name it something like `haven-office-github-actions`.
4. Use `Accounts in this organizational directory only`.
5. Create the app.

After creation, record:

- `Application (client) ID` as `AZURE_CLIENT_ID`
- `Directory (tenant) ID` as `AZURE_TENANT_ID`

## Step 5: Create The Client Secret

Inside that app registration:

1. Open `Certificates & secrets`.
2. Open `Client secrets`.
3. Create `New client secret`.
4. Give it a descriptive name like `github-actions-windows-signing`.
5. Choose an expiry that your team will actually rotate on time.

Record the secret **value** immediately. Azure shows it once.

Store it as:

- `AZURE_CLIENT_SECRET`

## Step 6: Assign The Signing Role To The App

The app registration itself is not enough. The service principal must have permission to sign with the certificate profile.

You want this Azure role:

- `Artifact Signing Certificate Profile Signer`

Scope it as narrowly as possible:

- preferred: the certificate profile
- acceptable: the Artifact Signing account
- avoid: the whole subscription unless you have no choice

### Portal path

1. Open the Artifact Signing account.
2. Open `Access control (IAM)`.
3. Add a role assignment.
4. Pick `Artifact Signing Certificate Profile Signer`.
5. Choose `User, group, or service principal`.
6. Select the app registration / service principal you created.
7. Assign the role.

If you want the narrowest possible scope, assign at the certificate profile level.

### CLI path

If you already know the service principal object ID, you can assign directly:

```bash
az role assignment create \
  --assignee <SERVICE_PRINCIPAL_OBJECT_ID> \
  --role "Artifact Signing Certificate Profile Signer" \
  --scope "/subscriptions/<subscriptionId>/resourceGroups/<resource-group-name>/providers/Microsoft.CodeSigning/codeSigningAccounts/<artifact-signing-account-name>/certificateProfiles/<profileName>"
```

## Step 7: Collect The Final Credential Set

At this point you should have:

```text
AZURE_TENANT_ID
AZURE_CLIENT_ID
AZURE_CLIENT_SECRET
WINDOWS_SIGNING_ENDPOINT
WINDOWS_SIGNING_ACCOUNT_NAME
WINDOWS_SIGNING_CERT_PROFILE
WINDOWS_SIGNING_PUBLISHER_NAME
```

Example mapping:

```text
AZURE_TENANT_ID=11111111-1111-1111-1111-111111111111
AZURE_CLIENT_ID=22222222-2222-2222-2222-222222222222
AZURE_CLIENT_SECRET=<secret value from Entra>
WINDOWS_SIGNING_ENDPOINT=https://weu.codesigning.azure.net/
WINDOWS_SIGNING_ACCOUNT_NAME=havenco-signing
WINDOWS_SIGNING_CERT_PROFILE=haven-office
WINDOWS_SIGNING_PUBLISHER_NAME=havenCo
```

## Step 8: Add The Secrets To GitHub

Use the GitHub `release` environment.

### GitHub UI

1. Open the repository on GitHub.
2. Go to `Settings`.
3. Open `Environments`.
4. Open the `release` environment.
5. Under `Environment secrets`, add each secret listed above.

### GitHub CLI

```bash
gh secret set --env release AZURE_TENANT_ID
gh secret set --env release AZURE_CLIENT_ID
gh secret set --env release AZURE_CLIENT_SECRET
gh secret set --env release WINDOWS_SIGNING_ENDPOINT
gh secret set --env release WINDOWS_SIGNING_ACCOUNT_NAME
gh secret set --env release WINDOWS_SIGNING_CERT_PROFILE
gh secret set --env release WINDOWS_SIGNING_PUBLISHER_NAME
```

Confirm they exist:

```bash
gh secret list --env release
```

## Step 9: Wire `electron-builder`

Add Azure signing options to the `win` section in [electron-builder.yml](../../electron-builder.yml):

```yaml
win:
  icon: build/icon.ico
  target:
    - target: nsis
      arch:
        - x64
  azureSignOptions:
    publisherName: "${env.WINDOWS_SIGNING_PUBLISHER_NAME}"
    endpoint: "${env.WINDOWS_SIGNING_ENDPOINT}"
    certificateProfileName: "${env.WINDOWS_SIGNING_CERT_PROFILE}"
    codeSigningAccountName: "${env.WINDOWS_SIGNING_ACCOUNT_NAME}"
```

For the first public Windows release, prefer `nsis` only. Keep `portable` out of the supported path until update and support behavior are defined.

## Step 10: Wire The Windows GitHub Actions Job

The Windows release job in [.github/workflows/release.yml](../../.github/workflows/release.yml) should:

- use the `release` environment
- expose the Azure credentials to the job

Example shape:

```yaml
build-windows:
  name: Build Windows release
  if: github.event_name == 'workflow_dispatch' && (github.event.inputs.platforms == 'windows' || github.event.inputs.platforms == 'all')
  runs-on: windows-latest
  environment: release
  env:
    RELEASE_REF: ${{ github.event.inputs.ref || 'master' }}
    AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
    AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
    AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
    WINDOWS_SIGNING_ENDPOINT: ${{ secrets.WINDOWS_SIGNING_ENDPOINT }}
    WINDOWS_SIGNING_ACCOUNT_NAME: ${{ secrets.WINDOWS_SIGNING_ACCOUNT_NAME }}
    WINDOWS_SIGNING_CERT_PROFILE: ${{ secrets.WINDOWS_SIGNING_CERT_PROFILE }}
    WINDOWS_SIGNING_PUBLISHER_NAME: ${{ secrets.WINDOWS_SIGNING_PUBLISHER_NAME }}
```

Then keep the build step as:

```yaml
- name: Build Windows distributables
  run: pnpm dist:win
```

## Step 11: Verify Signatures In CI

Add a verification step after packaging.

Example:

```yaml
- name: Verify signatures
  shell: pwsh
  run: |
    $ErrorActionPreference = "Stop"
    signtool verify /pa "release\\win-unpacked\\Haven Office.exe"
    Get-ChildItem release -Filter *.exe | ForEach-Object {
      signtool verify /pa $_.FullName
    }
```

If you want stricter validation, also verify bundled executables:

```yaml
- name: Verify bundled runtime signatures
  shell: pwsh
  run: |
    $ErrorActionPreference = "Stop"
    signtool verify /pa "release\\win-unpacked\\resources\\app-server\\node-bin\\node.exe"
    Get-ChildItem "release\\win-unpacked\\resources\\app-server\\server\\node_modules\\@embedded-postgres\\windows-x64\\native\\bin" -Filter *.exe | ForEach-Object {
      signtool verify /pa $_.FullName
    }
```

## Step 12: Test The Signed Build

Use a clean Windows 11 VM or clean machine.

Test this sequence:

1. Download the signed NSIS installer.
2. Confirm Windows shows the expected publisher.
3. Install the app.
4. Launch without any local Node install.
5. Confirm the Paperclip UI loads.
6. Quit and relaunch.
7. Uninstall and reinstall.
8. Test update flow between two signed versions.

## Rotation And Maintenance

### Client secret rotation

Before `AZURE_CLIENT_SECRET` expires:

1. Create a new client secret on the same app registration.
2. Update the GitHub `release` environment secret.
3. Run a Windows signing build.
4. Remove the old client secret only after the new one is confirmed.

### Publisher name changes

If Microsoft reissues the certificate with a different common name, update:

- `WINDOWS_SIGNING_PUBLISHER_NAME`
- `electron-builder` config if you hardcoded it anywhere
- any updater verification logic that depends on publisher name

### Role assignment troubleshooting

If signing fails with authorization or forbidden errors:

- confirm the app registration's service principal was assigned the role
- confirm the scope points to the correct certificate profile
- wait a few minutes for RBAC propagation
- confirm you used the service principal identity, not just the app registration display name

## Common Failure Modes

### `403 Forbidden` from Azure signing

Usually one of:

- wrong role assignment
- role assigned at the wrong scope
- wrong account name, endpoint, or certificate profile
- RBAC propagation delay

### `publisherName` mismatch

The publisher name must match the certificate CN exactly. Copy it from Azure rather than guessing.

### Unsigned build produced

If `electron-builder` silently skips signing, check that:

- all Azure env vars are present in the Windows job
- `azureSignOptions` is under `win`
- the build is running on a Windows runner

### SmartScreen warnings still appear

That does not always mean signing failed. A correctly signed binary can still have low SmartScreen reputation on a new publisher or newly issued certificate.

## Optional Fallback: OV `.pfx` Signing

If Azure Artifact Signing is unavailable, you can fall back to an exportable OV certificate in `.pfx` format.

Typical secrets for that path are:

- `WIN_CSC_LINK`
- `WIN_CSC_KEY_PASSWORD`

That approach is operationally simpler but weaker, because GitHub must hold a usable signing credential.

## Source References

- Electron Builder Windows signing:
  https://www.electron.build/code-signing-win.html
- Electron Builder Windows configuration:
  https://www.electron.build/win.html
- Azure Artifact Signing quickstart:
  https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
- Azure Artifact Signing role assignment tutorial:
  https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles
- Microsoft Entra app registration and client secret setup:
  https://learn.microsoft.com/en-us/entra/identity-platform/howto-create-service-principal-portal
- Azure RBAC role assignment in the portal:
  https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-portal
- GitHub Actions environment secrets:
  https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets
- SignTool reference:
  https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool
