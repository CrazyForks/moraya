<!-- AUTO-GENERATED from moraya-site/src/content/legal/privacy.en.md (v2.0).
     DO NOT EDIT — run `pnpm sync:legal` in moraya-site. -->

# Privacy Policy for Moraya

**Effective Date:** 2026-08-05 · **Version:** 2.0

Moraya is a local-first Markdown editor and knowledge workspace: **your writing, your keys, your AI — on your device.** This Privacy Policy explains what data Moraya handles, where it lives, and which third parties are involved — across every platform we ship.

By using Moraya, you agree to the practices described in this policy.

## Summary

- **Moraya does not operate servers that store your documents.** Your notes live on your device by default. Cloud sync is optional and, on Moraya Web and Moraya Mobile, end-to-end encrypted.
- **Zero telemetry.** Moraya contains no analytics, no usage tracking, and no crash reporting. We cannot see how you use the app.
- **Bring Your Own Key.** AI features connect directly from your device to the AI provider you choose, using your own API key. There is no Moraya relay in between.
- **Offline first.** Every platform works without an account and without a network connection. Connecting a cloud account (Picora) is always opt-in.
- **We never sell your data and never train AI models on your content.**

## 1. Scope and Platforms

This policy covers the Moraya product family:

| Platform | Distribution | Source code |
|---|---|---|
| **Moraya Desktop** (macOS, Windows, Linux) | Direct download, Homebrew | Open source (Apache-2.0) |
| **Moraya Web** (PWA at app.moraya.app) | Browser | Proprietary |
| **Moraya Mobile** (iOS, Android) | App Store, Google Play | Proprietary |
| **@moraya/core** (shared editor engine) | npm | Open source (GPL-3.0) |

Sections below are marked with the platforms they apply to. Visiting our website (moraya.app) or GitHub repositories is governed by those services' own policies.

## 2. What Moraya Does NOT Collect

- **No telemetry, no analytics, no crash reporting.** Moraya ships with no tracking SDK of any kind. We do not collect usage statistics, error reports, performance metrics, device fingerprints, or advertising identifiers — on any platform, ever. If a future version introduces optional diagnostics, it will be off by default and this policy will be updated first.
- **No document content on Moraya servers.** We do not run infrastructure that receives your notes in readable form. When you enable cloud sync on Moraya Web or Mobile, only end-to-end encrypted ciphertext leaves your device.
- **No tracking across apps or websites.** No IDFA/IDFV, no contacts, no location, no browsing history.
- **No data sales, no AI training on your content.**

## 3. Local Data Storage *(all platforms)*

Moraya is local-first. Without any account or configuration:

- **Desktop** — documents are ordinary Markdown files in folders you choose. Settings live in the app's local configuration directory. All credentials (API keys, tokens) are stored in the operating system's native secure storage: macOS Keychain, Windows Credential Manager, or Linux Secret Service (libsecret). Knowledge-base search indexes are stored in a local `.moraya/indexes/` directory. Nothing is uploaded.
- **Web** — documents, settings, and AI conversation history are stored inside your browser (localStorage, sessionStorage, and IndexedDB). A service worker caches the app so it keeps working offline (PWA). By default your notes stay in a local IndexedDB store; cloud storage is opt-in.
- **Mobile** — same storage model as Web, inside the app's sandboxed WebView storage on your device.

Local logs (if any) stay on your device and are never transmitted unless you choose to share them when reporting a bug.

## 4. Optional Cloud Account: Picora *(Desktop, Web, Mobile — opt-in)*

Moraya works fully without an account. You may optionally connect a **Picora** account (api.picora.me) for cloud features:

- **What is uploaded, and only when you trigger it:** knowledge-base documents you choose to sync, and images/videos you upload through Picora media hosting. On Moraya Web and Mobile, synced note content is end-to-end encrypted before upload (see Section 5); Picora stores ciphertext plus minimal object metadata (path, size, ETag).
- **Account data held by Picora:** your email address, Picora user ID, and — if you subscribe — your subscription tier and billing status.
- **How sign-in works:** OAuth 2.0 Device Flow. On Desktop the refresh token is stored in the OS keychain; access tokens are short-lived and held in memory. On Web the access token is kept in browser sessionStorage; the refresh token is never exposed to the page.
- **Disconnecting:** you can sign out at any time; local documents are unaffected. Account deletion and data export are described in Section 13.

Picora is operated as a separate service with its own privacy policy, available at picora.me.

## 5. End-to-End Encryption *(Web, Mobile — opt-in)*

When you enable encryption on Moraya Web or Mobile:

- Note content is encrypted **on your device** with AES-256-GCM. The encryption key is derived from your master passphrase using Argon2id. **Your master passphrase and master key never leave your device.**
- Recovery is via a 12-word BIP-39 recovery code that you generate and store yourself. **If you lose both the passphrase and the recovery code, your encrypted notes are unrecoverable — by design, we cannot reset them.**
- Optionally, per-document data keys can be wrapped by a cloud KMS **that you provide**: AWS KMS, Alibaba Cloud KMS, Tencent Cloud KMS, or Google Cloud KMS. KMS credentials are yours, configured by you, and requests go directly from your device to your KMS. Key-usage audit logs, if any, are maintained by your cloud provider.
- Encryption uses standard WebCrypto APIs (NIST-exempt for export-control purposes; we file `ITSAppUsesNonExemptEncryption = false` with Apple).

## 6. AI Features — Bring Your Own Key *(all platforms — opt-in)*

Moraya's AI assistance is disabled until you configure a provider and your own API key.

- **Direct connection, no intermediary.** When you invoke an AI feature, your selected text, prompt, and relevant context are sent **directly from your device** to the provider you chose (e.g. `api.anthropic.com`, `api.openai.com`). Moraya operates no relay, proxy, or logging layer in between. Responses stream directly back to your device.
- **Key storage.** On Desktop, API keys live in the OS keychain and are injected into requests by the local Rust backend — they are never exposed to the UI layer, logs, or disk in plaintext. On Web and Mobile, keys are stored in your browser/app's local storage on your device and used directly from there.
- **Supported providers** (each processes your input under its own privacy policy):
  - Anthropic (Claude) — anthropic.com/legal/privacy
  - OpenAI — openai.com/policies/privacy
  - Google (Gemini) — policies.google.com/privacy
  - DeepSeek — deepseek.com/privacy_policy
  - xAI (Grok) — x.ai/legal/privacy-policy
  - Mistral — mistral.ai/privacy-policy
  - Zhipu AI (GLM) — open.bigmodel.cn/privacy
  - MiniMax — see their official site
  - ByteDance (Doubao / Volcano Engine) — volcengine.com
  - **Ollama and other local models** — processing happens entirely on your device; nothing is sent externally
  - **Custom OpenAI-compatible endpoints** — data goes to the endpoint you configure; review that service's policy
- **Knowledge-base embeddings.** Building or searching a semantic index sends document text chunks or your query to the embedding endpoint of your configured provider (or a local model). Indexes themselves are stored locally (Desktop) or in your chosen storage (Web).

We do not store, log, or have any ability to access your AI conversations.

## 7. Bring Your Own Cloud Storage *(opt-in)*

- **Web/Mobile knowledge-base storage:** besides the default local IndexedDB store, you may connect your own object storage — Picora, AWS S3, Alibaba Cloud OSS, Tencent Cloud COS, Cloudflare R2, or Backblaze B2. Credentials are entered by you, used from your device to sign requests, and are not sent to Moraya.
- **Desktop image hosting:** you may configure Qiniu, Alibaba Cloud OSS, Tencent Cloud COS, AWS S3, or Google Cloud Storage to host images in your documents. Upload requests are HMAC-signed by the local Rust backend using credentials from the OS keychain and sent directly to the provider.

Files stored with these providers are governed by their respective policies. Moraya keeps no copies.

## 8. Voice Features *(Desktop cloud transcription — opt-in; Mobile — on-device)*

- **Desktop cloud transcription:** if you configure a speech provider (Deepgram, Gladia, AssemblyAI, Azure Speech, Tencent ASR, or OpenAI Realtime), your microphone audio streams in real time **directly from your device** to that provider over WebSocket. We do not record, store, or access your audio. Optional local recording backup saves audio only to a folder you choose. Speaker profiles for speaker identification are stored locally only.
- **Mobile:** speech-to-text and text-to-speech use the operating system's on-device engines. Audio does not leave your device unless you explicitly configure a cloud provider.

## 9. Publishing and Git *(Desktop, Web — opt-in)*

- Publishing to **GitHub** sends the document content directly from your device to the GitHub API using your personal access token (stored in the OS keychain on Desktop). Published content is governed by GitHub's Privacy Statement.
- Publishing to a **custom API endpoint** or generating an **RSS feed** sends content to the endpoint you configure.
- Git sync credentials (usernames, passwords, SSH keys) on Desktop are stored in the OS keychain.

## 10. MCP Servers *(Desktop, Web — opt-in)*

Moraya can connect to Model Context Protocol (MCP) servers to extend AI capabilities:

- **Local (stdio) servers** on Desktop run as child processes on your device; Moraya asks for your explicit confirmation before launching one for the first time.
- **Remote (SSE/HTTP) servers**: tool invocations — including arguments that may contain your content — are sent to the server URL you configure. Server configurations (URL, headers) are stored locally on your device.
- We do not operate MCP servers and have no visibility into data exchanged with servers you configure. You are responsible for trusting the servers you connect.

## 11. Mobile Device Permissions *(Mobile — each opt-in at the OS level)*

- **Camera** — photos you capture for OCR are processed locally on your device; images never leave it.
- **Microphone** — used for on-device speech recognition, or streamed to a speech provider only if you configured one (Section 8).
- **Biometrics (Face ID / Touch ID / fingerprint)** — used only to ask the OS to confirm a match for app unlock; biometric data never leaves your device and is never accessible to Moraya.
- **Photo library** — images you attach are stored inside your (optionally end-to-end encrypted) notes.
- **Push notifications** — if you enable notifications, a push token (APNs on iOS, FCM on Android) is registered so notifications you asked for can be delivered. Disable notifications at any time in system settings.

## 12. Account, Subscription and Billing *(Web, Mobile — opt-in)*

If you subscribe to a paid plan:

- Payments are processed by **Stripe**, **Alipay**, **Apple In-App Purchase**, or **Google Play Billing**. **Moraya never receives or stores your card or payment credentials** — we receive only your subscription tier and billing status.
- Entitlements are delivered as a signed token stored in your browser's sessionStorage.
- To enforce plan limits, aggregate usage counters (number of AI calls, knowledge bases, and registered devices — never content) are synced with the billing service. Your device list (device name, platform, last-active time) is visible to you and used for seat management; you can revoke devices at any time.

## 13. Your Rights and Data Control

- **Access / Portability** — export all your notes as Markdown files at any time (your documents are plain Markdown to begin with).
- **Deletion** — delete your Picora account in Settings → Account; associated server records are purged within 30 days. Local data is deleted by uninstalling the app or clearing browser storage.
- **Cookies** — Moraya Web uses no tracking cookies; authentication state is kept in browser session storage.
- If you are in the EU, UK, or California, you have additional rights under GDPR / UK-GDPR / CCPA. Contact privacy@moraya.app.

## 14. App Updates *(Desktop)*

Update checks download release information and installers directly from GitHub Releases. No identifying information, version pings, or usage data are sent by Moraya.

## 15. External Resources and Links *(all platforms)*

Documents may embed images, videos, or iframes from remote URLs. When rendered, those resources load directly from their source, and the external site may see your request metadata (IP address, user agent). Links you click open outside Moraya; external sites have their own policies.

## 16. Open Source and Auditability

- **Moraya Desktop** is open source under Apache-2.0 (github.com/zouwei/moraya). Every claim in this policy about the Desktop app — zero telemetry, keychain storage, direct provider connections — is verifiable in the source code.
- **@moraya/core**, the shared editor engine used by all platforms, is open source under GPL-3.0.
- **Moraya Web and Moraya Mobile** are proprietary, but follow the same data principles described here and are built on the same open-source core.

## 17. Security

Sensitive credentials are kept in OS-native secure storage (Desktop) or browser storage scoped to your device (Web/Mobile); all external communication is authenticated on-device before it leaves your machine. No method of storage or transmission is 100% secure — please protect your device, your passphrase, and the API keys you configure. Report vulnerabilities to security@moraya.app.

## 18. Children's Privacy

Moraya is not intended for users under 13 (16 in the EU). We do not knowingly collect personal information from children; contact us if you believe a child has provided data through a Picora account.

## 19. Changes to This Policy

We will post updates on moraya.app and, for material changes affecting account holders, notify in-app and by email at least 30 days before they take effect. The English version of this policy is authoritative; translations are provided for convenience.

## 20. Contact

- Privacy questions: privacy@moraya.app
- Security disclosures: security@moraya.app
- Legal: legal@moraya.app
- Open-source issues: github.com/zouwei/moraya/issues

Thank you for using Moraya.
