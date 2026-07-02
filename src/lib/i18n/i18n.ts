/**
 * Thin shell over `@moraya/core/i18n` — the unified i18n engine introduced
 * in v0.96.0. This file used to own its own implementation + 12 locale
 * JSONs; the engine and the locales now live in moraya-core.
 *
 * Public surface preserved for the 1,716 existing PC callsites:
 *   - `t` stays a Svelte derived store so `$t('foo')` template usage
 *     keeps auto re-rendering on locale switch.
 *   - `setLocale` stays sync-callable (eager preload at module load means
 *     the bundle is already cached when the consumer calls it).
 *   - `resolveForLocale` / `resolveAllLocales` stay sync — same reason.
 *   - `detectSystemLocale`, `isRTL` re-exported verbatim.
 *
 * Persistence: lives in `src/lib/stores/settings-store.ts` via Tauri
 * plugin-store. This shell doesn't touch persistence; the settings-store
 * calls `setLocale(...)` itself after restoring its state from disk.
 */

import {
  t as coreT,
  setLocale as coreSetLocale,
  locale as coreLocale,
  preloadAllLocales,
  detectSystemLocale,
  isRTL,
  resolveForLocale,
  resolveAllLocales,
  type SupportedLocale,
} from '@moraya/core/i18n'
import { derived } from 'svelte/store'

// Eager-load all 12 bundles at module load — restores the PC-era assumption
// that every locale's strings are sync-available (the prior implementation
// statically imported all 12 JSONs at the top of the file). This Promise
// resolves quickly (~12 dynamic imports running in parallel via the
// bundler's chunk loader) and is awaited inside loader.ts's memoized cache.
void preloadAllLocales()

/**
 * App-local i18n overrides. moraya consumes the *published* `@moraya/core` for
 * its 12-locale message set, so a brand-new UI string would otherwise need a
 * core release. This map adds app-only keys here — fully localized across all
 * 12 locales — to be folded into core on its next release. `t` checks this map
 * first, then falls back to core.
 */
const LOCAL_OVERRIDES: Partial<Record<SupportedLocale, Record<string, string>>> = {
  'en':      { 'mcp.lan.only_stdio': 'Only stdio servers can be exposed over LAN. http/sse servers already have a network URL.', 'menu.undo': 'Undo', 'menu.redo': 'Redo', 'menu.select_all': 'Select All', 'mcp.lan.expose': 'Expose over LAN', 'mcp.lan.config': 'Config', 'mcp.lan.copy': 'Copy', 'mcp.lan.copy_config': 'Copy config', 'mcp.lan.hint': 'Same Wi-Fi only. Sent in plaintext over the LAN, secured by the token. macOS may ask to allow incoming connections.', 'mcp.lan.scan_hint': 'Scan with the Moraya mobile app' },
  'zh-CN':   { 'mcp.lan.only_stdio': '仅 stdio 类型的服务可暴露到局域网。http/sse 服务本身已有网络地址，无需桥接。', 'menu.undo': '撤销', 'menu.redo': '重做', 'menu.select_all': '全选', 'mcp.lan.expose': '暴露到局域网', 'mcp.lan.config': '配置', 'mcp.lan.copy': '复制', 'mcp.lan.copy_config': '复制配置', 'mcp.lan.hint': '需同一 Wi-Fi。局域网内明文传输、由 token 保护；macOS 可能弹窗请求允许传入连接。', 'mcp.lan.scan_hint': '用 Moraya 手机端扫码接入' },
  'zh-Hant': { 'mcp.lan.only_stdio': '僅 stdio 類型的服務可暴露到區域網路。http/sse 服務本身已有網路位址，無需橋接。', 'menu.undo': '復原', 'menu.redo': '重做', 'menu.select_all': '全選', 'mcp.lan.expose': '暴露到區域網路', 'mcp.lan.config': '設定', 'mcp.lan.copy': '複製', 'mcp.lan.copy_config': '複製設定', 'mcp.lan.hint': '需同一 Wi-Fi。區域網路內明文傳輸、由 token 保護；macOS 可能彈窗請求允許傳入連線。', 'mcp.lan.scan_hint': '用 Moraya 手機端掃碼接入' },
  'ar':      { 'mcp.lan.only_stdio': 'يمكن كشف خوادم stdio فقط عبر الشبكة المحلية. خوادم http/sse لديها بالفعل عنوان شبكة.', 'menu.undo': 'تراجع', 'menu.redo': 'إعادة', 'menu.select_all': 'تحديد الكل', 'mcp.lan.expose': 'الكشف عبر الشبكة المحلية', 'mcp.lan.config': 'الإعداد', 'mcp.lan.copy': 'نسخ', 'mcp.lan.copy_config': 'نسخ الإعداد', 'mcp.lan.hint': 'نفس شبكة Wi-Fi فقط. يُرسل كنص عادي عبر الشبكة المحلية، محميًا بالرمز.', 'mcp.lan.scan_hint': 'امسح باستخدام تطبيق Moraya' },
  'de':      { 'mcp.lan.only_stdio': 'Nur stdio-Server können im LAN freigegeben werden. http/sse-Server haben bereits eine Netzwerk-URL.', 'menu.undo': 'Rückgängig', 'menu.redo': 'Wiederholen', 'menu.select_all': 'Alles auswählen', 'mcp.lan.expose': 'Im LAN freigeben', 'mcp.lan.config': 'Konfig', 'mcp.lan.copy': 'Kopieren', 'mcp.lan.copy_config': 'Konfig kopieren', 'mcp.lan.hint': 'Nur gleiches WLAN. Im Klartext über das LAN, durch das Token gesichert. macOS fragt ggf. nach eingehenden Verbindungen.', 'mcp.lan.scan_hint': 'Mit der Moraya-App scannen' },
  'es':      { 'mcp.lan.only_stdio': 'Solo los servidores stdio pueden exponerse en la LAN. Los servidores http/sse ya tienen una URL de red.', 'menu.undo': 'Deshacer', 'menu.redo': 'Rehacer', 'menu.select_all': 'Seleccionar todo', 'mcp.lan.expose': 'Exponer en la LAN', 'mcp.lan.config': 'Configuración', 'mcp.lan.copy': 'Copiar', 'mcp.lan.copy_config': 'Copiar configuración', 'mcp.lan.hint': 'Solo la misma Wi-Fi. En texto plano por la LAN, protegido por el token. macOS puede pedir permitir conexiones entrantes.', 'mcp.lan.scan_hint': 'Escanea con la app de Moraya' },
  'fr':      { 'mcp.lan.only_stdio': 'Seuls les serveurs stdio peuvent être exposés sur le réseau local. Les serveurs http/sse ont déjà une URL réseau.', 'menu.undo': 'Annuler', 'menu.redo': 'Rétablir', 'menu.select_all': 'Tout sélectionner', 'mcp.lan.expose': 'Exposer sur le réseau local', 'mcp.lan.config': 'Config', 'mcp.lan.copy': 'Copier', 'mcp.lan.copy_config': 'Copier la config', 'mcp.lan.hint': 'Même Wi-Fi uniquement. En clair sur le réseau local, protégé par le jeton. macOS peut demander d’autoriser les connexions entrantes.', 'mcp.lan.scan_hint': 'Scannez avec l’app Moraya' },
  'hi':      { 'mcp.lan.only_stdio': 'केवल stdio सर्वर को LAN पर उपलब्ध कराया जा सकता है। http/sse सर्वर के पास पहले से नेटवर्क URL है।', 'menu.undo': 'पूर्ववत् करें', 'menu.redo': 'फिर से करें', 'menu.select_all': 'सभी चुनें', 'mcp.lan.expose': 'LAN पर उपलब्ध कराएं', 'mcp.lan.config': 'कॉन्फ़िग', 'mcp.lan.copy': 'कॉपी', 'mcp.lan.copy_config': 'कॉन्फ़िग कॉपी करें', 'mcp.lan.hint': 'केवल समान Wi-Fi। LAN पर सादे रूप में भेजा जाता है, टोकन से सुरक्षित।', 'mcp.lan.scan_hint': 'Moraya मोबाइल ऐप से स्कैन करें' },
  'ja':      { 'mcp.lan.only_stdio': 'LAN に公開できるのは stdio サーバーのみです。http/sse サーバーには既にネットワーク URL があります。', 'menu.undo': '取り消す', 'menu.redo': 'やり直す', 'menu.select_all': 'すべて選択', 'mcp.lan.expose': 'LAN に公開', 'mcp.lan.config': '設定', 'mcp.lan.copy': 'コピー', 'mcp.lan.copy_config': '設定をコピー', 'mcp.lan.hint': '同一 Wi-Fi のみ。LAN 上は平文で送信され、トークンで保護されます。macOS が着信接続の許可を求める場合があります。', 'mcp.lan.scan_hint': 'Moraya モバイルでスキャン' },
  'ko':      { 'mcp.lan.only_stdio': 'stdio 서버만 LAN에 노출할 수 있습니다. http/sse 서버에는 이미 네트워크 URL이 있습니다.', 'menu.undo': '실행 취소', 'menu.redo': '다시 실행', 'menu.select_all': '모두 선택', 'mcp.lan.expose': 'LAN에 노출', 'mcp.lan.config': '구성', 'mcp.lan.copy': '복사', 'mcp.lan.copy_config': '구성 복사', 'mcp.lan.hint': '동일 Wi-Fi만 가능. LAN에서 평문으로 전송되며 토큰으로 보호됩니다.', 'mcp.lan.scan_hint': 'Moraya 모바일 앱으로 스캔' },
  'pt':      { 'mcp.lan.only_stdio': 'Apenas servidores stdio podem ser expostos na LAN. Servidores http/sse já têm uma URL de rede.', 'menu.undo': 'Desfazer', 'menu.redo': 'Refazer', 'menu.select_all': 'Selecionar tudo', 'mcp.lan.expose': 'Expor na LAN', 'mcp.lan.config': 'Config', 'mcp.lan.copy': 'Copiar', 'mcp.lan.copy_config': 'Copiar config', 'mcp.lan.hint': 'Apenas o mesmo Wi-Fi. Em texto puro na LAN, protegido pelo token. O macOS pode pedir para permitir conexões.', 'mcp.lan.scan_hint': 'Escaneie com o app Moraya' },
  'ru':      { 'mcp.lan.only_stdio': 'В локальной сети можно открыть только stdio-серверы. У http/sse-серверов уже есть сетевой URL.', 'menu.undo': 'Отменить', 'menu.redo': 'Повторить', 'menu.select_all': 'Выделить всё', 'mcp.lan.expose': 'Открыть в локальной сети', 'mcp.lan.config': 'Конфиг', 'mcp.lan.copy': 'Копировать', 'mcp.lan.copy_config': 'Копировать конфиг', 'mcp.lan.hint': 'Только та же Wi-Fi. Передаётся открытым текстом по локальной сети, защищено токеном.', 'mcp.lan.scan_hint': 'Сканируйте в приложении Moraya' },
}

/**
 * Svelte derived store. `$t('foo')` in templates re-evaluates whenever the
 * locale store updates, so component re-renders are automatic. App-local
 * overrides resolve first, then core.
 */
export const t = derived(coreLocale, ($loc) => {
  return (...args: Parameters<typeof coreT>): string => {
    const [key, params] = args
    const override = LOCAL_OVERRIDES[$loc]?.[key] ?? LOCAL_OVERRIDES['en']?.[key]
    if (override !== undefined) {
      if (!params) return override
      return Object.entries(params).reduce(
        (acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)),
        override,
      )
    }
    return coreT(...args)
  }
})

/** Re-exported locale store for `import { locale } from '$lib/i18n'`. */
export const locale = coreLocale

/**
 * Sync-callable setLocale. Returns void (the prior signature). The async
 * load inside coreSetLocale resolves immediately after the eager preload
 * above finishes, and re-resolves are cache hits.
 */
export function setLocale(loc: SupportedLocale): void {
  void coreSetLocale(loc)
}

export { detectSystemLocale, isRTL, resolveForLocale, resolveAllLocales }
