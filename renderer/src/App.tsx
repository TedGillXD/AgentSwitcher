import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight, Check, CheckCheck, ChevronDown, ChevronRight, CircleAlert, CircleCheck,
  CircleDot, Download, Ellipsis, ExternalLink, Eye, EyeOff, FolderOpen, Globe2, KeyRound, Layers3, LoaderCircle,
  LockKeyhole, Pencil, Plus, Power, RefreshCw, Settings2, ShieldCheck, Sparkles,
  Terminal, Trash2, X, Zap,
} from 'lucide-react';
import type { ApiProfile, ApiProtocol, AppState, ConnectionResult, Language, ProviderPreset, SaveProfileInput, Settings, UpdateState } from '../../shared/types';
import { PROVIDER_PRESETS } from '../../shared/provider-presets';
import { translator, type Translate } from './i18n';
import { friendlyError } from './errors';

const api = window.agentSwitcher;
const query = new URLSearchParams(window.location.search);
const isManager = query.get('window') === 'settings';
document.documentElement.classList.toggle('manager-window', isManager);

const previewSettings: Settings = {
  language: 'zh-CN', codexHome: '', codexAppPath: '', deepseekBaseUrl: 'https://api.deepseek.com',
  deepseekModel: 'deepseek-flash', launchAtLogin: false, hideOnBlur: false,
};
const previewState: AppState = {
  version: '0.2.4', platform: 'preview', settings: previewSettings,
  profiles: [{ id: 'deepseek', name: 'DeepSeek', preset: 'deepseek', baseUrl: 'https://api.deepseek.com', protocol: 'auto', modelIds: ['deepseek-flash', 'deepseek-v4-pro'], defaultModel: 'deepseek-flash', hasApiKey: false }],
  activeProfile: 'chatgpt', hasApiKey: false, encryptionAvailable: true, codexInstalled: true,
  codexRunning: true, detectedAppPath: null, bridgeRunning: false, lastSwitchedAt: null, lastError: null,
};

type Notice = { kind: 'success' | 'error'; text: string };
type Confirmation = { kind: 'switch'; id: string; name: string } | { kind: 'restart' | 'quit' } |
  { kind: 'delete'; profile: ApiProfile; onDeleted: (state: AppState) => void } |
  { kind: 'discard'; next: () => void };
interface Controller {
  state: AppState; setState: (state: AppState) => void; t: Translate; busy: string | null; loaded: boolean;
  disabled: boolean; run: (name: string, task: () => Promise<void>) => Promise<boolean>;
  report: (notice: Notice) => void; confirm: (value: Confirmation) => void;
  changeLanguage: (language: Language) => Promise<void>;
}

function Brand() {
  return <span className="brand-mark" aria-hidden="true"><svg width="23" height="23" viewBox="0 0 24 24" fill="none"><path d="M5 7.5h13m-3.5-3.5L18 7.5 14.5 11M19 16.5H6m3.5 3.5L6 16.5 9.5 13" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>;
}

function ProviderIcon({ preset, small = false }: { preset: ProviderPreset | 'chatgpt'; small?: boolean }) {
  return <span className={`provider-icon provider-${preset} ${small ? 'provider-small' : ''}`} aria-hidden="true">{preset === 'chatgpt' ? <Sparkles size={small ? 17 : 25} strokeWidth={1.5} /> : preset === 'custom' ? <Layers3 size={small ? 15 : 22} strokeWidth={1.6} /> : <span>{preset === 'deepseek' ? 'D' : preset === 'glm' ? 'G' : 'K'}</span>}</span>;
}

function host(url: string): string { try { return new URL(url).hostname; } catch { return url; } }

function App() {
  const [state, setState] = useState<AppState>(previewState);
  const [loaded, setLoaded] = useState(!api);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStateError = useRef<string | null>(null);
  const loadFailureNotice = useRef<Notice | null>(null);
  const t = translator(state.settings.language);
  const report = useCallback((value: Notice) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(value);
    if (value.kind === 'success') noticeTimer.current = setTimeout(() => setNotice(null), 6000);
  }, []);
  const applyState = useCallback((next: AppState) => {
    setState(next); setLoaded(true); setLoadFailed(false);
    const failureNotice = loadFailureNotice.current;
    if (failureNotice) {
      setNotice((current) => current === failureNotice ? null : current);
      loadFailureNotice.current = null;
    }
    if (next.lastError && next.lastError !== lastStateError.current) {
      report({ kind: 'error', text: friendlyError(next.lastError, next.settings.language) });
    }
    lastStateError.current = next.lastError;
  }, [report]);
  const load = useCallback(async () => {
    if (!api) return;
    setLoadFailed(false);
    try {
      applyState(await api.getState());
    } catch (error) {
      setLoadFailed(true);
      const failureNotice: Notice = { kind: 'error', text: friendlyError(error, 'zh-CN') };
      loadFailureNotice.current = failureNotice;
      report(failureNotice);
    }
  }, [applyState, report]);
  useEffect(() => {
    void load();
    const unsubscribe = api?.onStateChanged(applyState);
    return () => { unsubscribe?.(); if (noticeTimer.current) clearTimeout(noticeTimer.current); };
  }, [load, applyState]);
  useEffect(() => {
    document.documentElement.lang = state.settings.language;
    document.title = isManager ? t('manager') : 'Agent Switcher';
  }, [state.settings.language, t]);
  const run = async (name: string, task: () => Promise<void>): Promise<boolean> => {
    if (!api || busy) return false;
    setBusy(name); setNotice(null);
    try { await task(); return true; }
    catch (error) { report({ kind: 'error', text: friendlyError(error, state.settings.language) }); return false; }
    finally { setBusy(null); }
  };
  const runWindowAction = async (task: () => Promise<void>): Promise<void> => {
    try { await task(); }
    catch (error) { report({ kind: 'error', text: friendlyError(error, state.settings.language) }); }
  };
  const changeLanguage = async (language: Language) => {
    if (language === state.settings.language) return;
    if (!api) { setState((old) => ({ ...old, settings: { ...old.settings, language } })); return; }
    await run('language', async () => { applyState(await api.saveSettings({ ...state.settings, language })); });
  };
  const controller: Controller = { state, setState: applyState, t, busy, loaded, disabled: !!busy || !api || !loaded, run, report, confirm: setConfirmation, changeLanguage };
  const handleConfirm = async () => {
    const action = confirmation;
    if (!action) return;
    setConfirmation(null);
    if (action.kind === 'discard') { action.next(); return; }
    if (action.kind === 'switch') await run(`switch:${action.id}`, async () => {
      const result = await api!.switchProfile(action.id);
      applyState(result.state); report({ kind: 'success', text: t(result.state.platform === 'darwin' ? 'switchedMac' : 'switched', { name: action.name }) });
    });
    if (action.kind === 'restart') await run('restart', async () => { applyState(await api!.restartCodex()); report({ kind: 'success', text: t('restarted') }); });
    if (action.kind === 'quit') await runWindowAction(() => api!.quit(true));
    if (action.kind === 'delete') await run('delete', async () => {
      const next = await api!.deleteProfile(action.profile.id);
      applyState(next); action.onDeleted(next); report({ kind: 'success', text: t('profileDeleted') });
    });
  };
  return <div className={`app-shell ${isManager ? 'manager-shell' : 'panel-shell'}`}>
    <header className="titlebar">
      <div className="brand"><Brand /><span>Agent Switcher</span>{isManager ? <><span className="titlebar-divider" /><span className="window-title">{t('manager')}</span></> : <span className="version-label">BETA</span>}</div>
      <div className="titlebar-actions no-drag">
        <button className="icon-button language-button" aria-label={t('language')} title={t('language')} disabled={!!busy} onClick={() => void changeLanguage(state.settings.language === 'zh-CN' ? 'en' : 'zh-CN')}><Globe2 size={15} /><span>{state.settings.language === 'zh-CN' ? 'EN' : '中'}</span></button>
        {!isManager && <div className="menu-anchor"><button className={`icon-button ${menuOpen ? 'selected' : ''}`} aria-label={t('more')} title={t('more')} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><Ellipsis size={19} /></button>{menuOpen && <><button className="menu-dismiss" aria-label={t('cancel')} onClick={() => setMenuOpen(false)} /><div className="popover-menu" role="menu">
          <button role="menuitem" disabled={controller.disabled} onClick={() => { setMenuOpen(false); void run('manage', () => api!.openSettings()); }}><Settings2 size={14} />{t('manage')}</button>
          <button role="menuitem" disabled={controller.disabled} onClick={() => { setMenuOpen(false); void run('refresh', async () => applyState(await api!.getState())); }}><RefreshCw size={14} />{t('refresh')}</button>
          <div className="menu-divider" /><button role="menuitem" disabled={!api} onClick={() => { setMenuOpen(false); if (state.bridgeRunning) setConfirmation({ kind: 'quit' }); else void runWindowAction(() => api!.quit()); }}><Power size={14} />{t('quit')}</button>
        </div></>}</div>}
        <button className="icon-button" aria-label={t(isManager ? 'close' : 'hide')} title={t(isManager ? 'close' : 'hide')} disabled={!api} onClick={() => void runWindowAction(() => isManager ? api!.closeSettings() : api!.hideWindow())}><X size={17} /></button>
      </div>
    </header>
    {!api && <div className="preview-banner"><span>{t('preview')}</span>{t('previewHint')}</div>}
    {notice && <div className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.kind === 'error' ? <CircleAlert size={16} /> : <CircleCheck size={16} />}<span>{notice.text}</span><button className="icon-button" aria-label={t('dismiss')} onClick={() => setNotice(null)}><X size={14} /></button></div>}
    {!loaded ? <main className="loading-state"><LoaderCircle size={25} className="spin" /><p>{loadFailed ? t('unavailable') : t('loading')}</p>{loadFailed && <button className="button secondary" onClick={() => void load()}>{t('retry')}</button>}</main> : isManager ? <Manager controller={controller} /> : <Panel controller={controller} />}
    <footer className="app-footer"><span><ShieldCheck size={11} />{t('localOnly')}</span><span className="footer-version">v{state.version}<span className="footer-dot">·</span>{state.platform === 'win32' ? 'Windows' : state.platform === 'darwin' ? 'macOS' : 'Preview'}</span></footer>
    {confirmation && <ConfirmDialog value={confirmation} t={t} onCancel={() => setConfirmation(null)} onConfirm={() => void handleConfirm()} />}
  </div>;
}

function Panel({ controller: c }: { controller: Controller }) {
  const { state, t } = c;
  const profiles = state.profiles ?? [];
  const activeApi = profiles.some((profile) => profile.id === state.activeProfile);
  const openManager = (id?: string) => void c.run('manage', () => api!.openSettings(id));
  const switched = state.lastSwitchedAt ? new Intl.DateTimeFormat(state.settings.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(state.lastSwitchedAt)) : null;
  return <>
    <div className="panel-toolbar"><span><Zap size={15} />{t('profiles')}</span><button className="text-button" disabled={c.disabled} onClick={() => openManager()}><Settings2 size={14} />{t('manage')}<ChevronRight size={13} /></button></div>
    <main className="content panel-content">
      <section className="workspace-panel"><div className="workspace-icon"><Terminal size={24} strokeWidth={1.6} /><span /></div><div className="workspace-info"><h1>{t('workspace')}</h1><p>{t('tagline')}</p></div><span className={`status-pill ${state.codexRunning ? 'running' : ''}`}><span className="status-dot" />{!state.codexInstalled ? t('notDetected') : state.codexRunning ? t('running') : t('stopped')}</span></section>
      <div className="section-heading"><h2>{t('activeConfiguration')}</h2><span className="profile-count">{String(profiles.length + 1).padStart(2, '0')}</span></div>
      {state.activeProfile === 'external' && <div className="external-note"><CircleDot size={15} /><div><strong>{t('external')}</strong><p>{t('externalHint')}</p></div></div>}
      <div className="profile-list">
        <section className={`profile-card ${state.activeProfile === 'chatgpt' ? 'is-active' : ''}`}>
          <div className="profile-topline"><ProviderIcon preset="chatgpt" /><div className="profile-identity"><h3>ChatGPT</h3><p>{t('accountSignIn')}</p></div>{state.activeProfile === 'chatgpt' && <ActiveBadge t={t} />}</div>
          <p className="profile-description">{t('chatgptDescription')}</p>
          <div className="profile-bottom"><span className="profile-meta"><span className="tiny-dot green" />{t('nativeLogin')}</span>{state.activeProfile === 'chatgpt' ? <CheckCheck size={18} className="current-check" /> : <button className="button profile-switch" disabled={c.disabled || !state.codexInstalled} onClick={() => c.confirm({ kind: 'switch', id: 'chatgpt', name: 'ChatGPT' })}>{t('switch')}<ArrowRight size={14} /></button>}</div>
        </section>
        {profiles.map((profile) => <section key={profile.id} className={`profile-card ${state.activeProfile === profile.id ? 'is-active' : ''}`}>
          <div className="profile-topline"><ProviderIcon preset={profile.preset} /><div className="profile-identity"><h3>{profile.name}</h3><p title={profile.baseUrl}>{host(profile.baseUrl)}</p></div>{state.activeProfile === profile.id && <ActiveBadge t={t} />}<button className="icon-button profile-edit" aria-label={t('editNamed', { name: profile.name })} title={t('editNamed', { name: profile.name })} disabled={c.disabled} onClick={() => openManager(profile.id)}><Pencil size={13} /></button></div>
          <div className="profile-models" title={profile.modelIds.join(', ')}>{profile.modelIds.slice(0, 3).map((model) => <span key={model}>{model}</span>)}{profile.modelIds.length > 3 && <span>+{profile.modelIds.length - 3}</span>}{!profile.modelIds.length && <em>{t('discoverAutomatically')}</em>}</div>
          <div className="profile-bottom"><span className={`profile-meta ${profile.hasApiKey ? '' : 'muted'}`}>{profile.hasApiKey ? <><KeyRound size={12} />{t('keySaved')}</> : <><span className="tiny-dot amber" />{t('keyRequired')}</>}</span>{state.activeProfile === profile.id ? <CheckCheck size={18} className="current-check" /> : profile.hasApiKey ? <button className="button profile-switch" disabled={c.disabled || !state.codexInstalled || !state.encryptionAvailable} onClick={() => c.confirm({ kind: 'switch', id: profile.id, name: profile.name })}>{c.busy === `switch:${profile.id}` ? <LoaderCircle size={13} className="spin" /> : null}{c.busy === `switch:${profile.id}` ? t('switching') : t('switch')}<ArrowRight size={14} /></button> : <button className="button profile-setup" disabled={c.disabled} onClick={() => openManager(profile.id)}>{t('setUp')}<ChevronRight size={14} /></button>}</div>
        </section>)}
      </div>
      <button className="add-profile-panel" disabled={c.disabled} onClick={() => openManager('new')}><Plus size={16} /><span>{t('addProfile')}</span><span className="add-profile-brands">GLM / Kimi / API</span></button>
      {!state.codexInstalled && <button className="setup-note" disabled={c.disabled} onClick={() => openManager('general')}><CircleAlert size={15} /><span>{t('appMissing')}</span><ChevronRight size={14} /></button>}
      {activeApi && <div className={`bridge-note ${state.bridgeRunning ? '' : 'offline'}`}><span className={`tiny-dot ${state.bridgeRunning ? 'green' : 'amber'}`} /><div><strong>{t(state.bridgeRunning ? 'bridgeActive' : 'bridgeOffline')}</strong><p>{t('bridgeHint')}</p></div></div>}
      <p className="switch-explainer"><RefreshCw size={13} /><span>{t('switchInfo')}</span></p>
      <div className="quick-actions"><button className="quick-action" disabled={c.disabled || !state.codexInstalled} onClick={() => c.confirm({ kind: 'restart' })}>{c.busy === 'restart' ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}<span>{c.busy === 'restart' ? t('restarting') : t('restart')}</span></button><span className="action-divider" /><button className="quick-action" disabled={c.disabled} onClick={() => void c.run('folder', () => api!.openConfigFolder())}><FolderOpen size={15} /><span>{t('openConfig')}</span></button></div>
      {switched && <p className="last-switch">{t('lastSwitched')} <span>{switched}</span></p>}
    </main>
  </>;
}

function ActiveBadge({ t }: { t: Translate }) { return <span className="active-badge"><Check size={12} />{t('current')}</span>; }

function Manager({ controller: c }: { controller: Controller }) {
  const { state, t } = c;
  const [selection, setSelection] = useState(query.get('profile') || 'new');
  const dirty = useRef(false);
  const profiles = state.profiles ?? [];
  const select = useCallback((next: string) => {
    if (next === selection) return;
    const change = () => { dirty.current = false; setSelection(next); };
    if (dirty.current) c.confirm({ kind: 'discard', next: change }); else change();
  }, [selection, c.confirm]);
  useEffect(() => api?.onEditProfile((id) => select(id || 'new')), [select]);
  const selected = profiles.find((profile) => profile.id === selection);
  return <div className="manager-layout">
    <aside className="manager-sidebar">
      <div className="sidebar-heading"><h1>{t('manager')}</h1><p>{t('managerSubtitle')}</p></div>
      <button className="button add-profile-sidebar" disabled={!!c.busy} onClick={() => select('new')}><Plus size={15} />{t('addProfile')}</button>
      <div className="sidebar-section-label">{t('apiProfiles')}<span>{profiles.length}</span></div>
      <nav className="profile-navigation" aria-label={t('apiProfiles')}>{profiles.map((profile) => <button key={profile.id} className={selection === profile.id ? 'selected' : ''} disabled={!!c.busy} onClick={() => select(profile.id)}><ProviderIcon preset={profile.preset} small /><span><strong>{profile.name}</strong><small>{host(profile.baseUrl)}</small></span>{state.activeProfile === profile.id && <span className="sidebar-active-dot" title={t('current')} />}</button>)}</nav>
      <button className={`general-navigation ${selection === 'general' ? 'selected' : ''}`} disabled={!!c.busy} onClick={() => select('general')}><Settings2 size={16} />{t('general')}<ChevronRight size={13} /></button>
      <div className="sidebar-security"><LockKeyhole size={13} /><span>{t('localOnly')}</span></div>
    </aside>
    {selection === 'general' ? <GeneralSettings key="general" controller={c} onDirty={(value) => { dirty.current = value; }} /> : <ProfileEditor key={selection} profile={selected} controller={c} onDirty={(value) => { dirty.current = value; }} onSaved={(id) => { dirty.current = false; setSelection(id); }} onDeleted={(next) => { dirty.current = false; setSelection(next.profiles[0]?.id ?? 'new'); }} />}
  </div>;
}

interface ProfileDraft {
  name: string; preset: ProviderPreset; baseUrl: string; protocol: ApiProtocol; modelsText: string; defaultModel: string;
}
function profileDraft(profile?: ApiProfile): ProfileDraft {
  return profile ? { name: profile.name, preset: profile.preset, baseUrl: profile.baseUrl, protocol: profile.protocol, modelsText: profile.modelIds.join('\n'), defaultModel: profile.defaultModel } : { name: '', preset: 'custom', baseUrl: '', protocol: 'auto', modelsText: '', defaultModel: '' };
}
function modelIds(text: string): string[] { return [...new Set(text.split(/[\s,]+/).map((model) => model.trim()).filter(Boolean))]; }

function ProfileEditor({ profile, controller: c, onDirty, onSaved, onDeleted }: { profile?: ApiProfile; controller: Controller; onDirty: (value: boolean) => void; onSaved: (id: string) => void; onDeleted: (state: AppState) => void }) {
  const { state, t } = c;
  const [draft, setDraft] = useState(() => profileDraft(profile));
  const [baseline, setBaseline] = useState(() => JSON.stringify(profileDraft(profile)));
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [clearKey, setClearKey] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [connection, setConnection] = useState<ConnectionResult | null>(null);
  const dirty = JSON.stringify(draft) !== baseline || !!key || clearKey;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const active = Boolean(profile && state.activeProfile === profile.id);
  const models = modelIds(draft.modelsText);
  const keyAvailable = Boolean(key.trim() || profile?.hasApiKey && !clearKey);
  const valid = !!draft.baseUrl.trim() && (keyAvailable || !!profile && clearKey) && state.encryptionAvailable;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => {
    if (!dirtyRef.current) {
      const next = profileDraft(profile); setDraft(next); setBaseline(JSON.stringify(next));
    }
  }, [profile]);
  const setField = <K extends keyof ProfileDraft>(name: K, value: ProfileDraft[K]) => { setDraft((old) => ({ ...old, [name]: value })); if (name === 'baseUrl' || name === 'protocol') setConnection(null); };
  const chooseTemplate = (preset: ProviderPreset) => {
    const template = PROVIDER_PRESETS.find((entry) => entry.preset === preset)!;
    setDraft({ name: template.name, preset, baseUrl: template.baseUrl, protocol: template.protocol, modelsText: '', defaultModel: '' });
    setConnection(null);
  };
  const discovered = async () => c.run('test', async () => {
    const result = await api!.testConnection({ profileId: profile?.id, apiKey: key.trim() || undefined, baseUrl: draft.baseUrl.trim(), protocol: draft.protocol });
    setConnection(result);
    if (result.ok && result.models?.length) {
      const found = result.models;
      setDraft((old) => ({ ...old, modelsText: found.join('\n'), defaultModel: found.includes(old.defaultModel) ? old.defaultModel : found[0]! }));
    }
    if (!result.ok) setAdvanced(true);
  });
  const save = async () => c.run('save-profile', async () => {
    const name = draft.name.trim() || PROVIDER_PRESETS.find((item) => item.preset === draft.preset)?.name || host(draft.baseUrl);
    const input: SaveProfileInput = { id: profile?.id, name, preset: draft.preset, baseUrl: draft.baseUrl.trim(), protocol: draft.protocol, modelIds: models.length ? models : undefined, defaultModel: draft.defaultModel || undefined, apiKey: key.trim() || undefined, clearApiKey: clearKey && !key.trim() };
    try {
      const next = await api!.saveProfile(input);
      c.setState(next); setKey(''); setShowKey(false); setClearKey(false); setConnection(null);
      const saved = next.profiles.find((item) => profile ? item.id === profile.id : !state.profiles.some((old) => old.id === item.id)) ?? next.profiles.find((item) => item.name === name && item.baseUrl === draft.baseUrl.trim().replace(/\/+$/, ''));
      if (saved) { const values = profileDraft(saved); setDraft(values); setBaseline(JSON.stringify(values)); onSaved(saved.id); }
      c.report({ kind: 'success', text: t('profileSaved') });
    } catch (error) { if (/MODEL|DISCOVERY/.test(String(error))) setAdvanced(true); throw error; }
  });
  return <section className="editor-column">
    <div className="editor-scroll">
      <div className="editor-heading"><div><div className="eyebrow">{profile ? t('editProfile') : t('essentials')}</div><h1>{profile?.name ?? t('newProfile')}</h1><p>{t('essentialsHint')}</p></div>{state.encryptionAvailable && <span className="security-badge"><ShieldCheck size={12} />{t('encrypted')}</span>}</div>
      {active && <div className="active-settings-note"><CircleAlert size={15} /><div><span>{t('activeLocked')}</span><button className="text-button" disabled={c.disabled || !state.codexInstalled} onClick={() => c.confirm({ kind: 'switch', id: 'chatgpt', name: 'ChatGPT' })}>{t('switchChatgpt')}<ArrowRight size={12} /></button></div></div>}
      <div className="field preset-field"><label>{t('provider')}</label><div className="provider-templates">{PROVIDER_PRESETS.map((template) => <button key={template.preset} className={draft.preset === template.preset ? 'selected' : ''} disabled={!!c.busy || active} onClick={() => chooseTemplate(template.preset)}><ProviderIcon preset={template.preset} small /><span>{template.name || t('custom')}</span>{draft.preset === template.preset && <Check size={12} />}</button>)}</div><p className="field-hint">{t('templateHint')}</p></div>
      <section className="settings-section connection-section">
        <div className="field"><label htmlFor="profile-name">{t('name')}<span className="optional-label">{t('optional')}</span></label><input id="profile-name" value={draft.name} maxLength={80} placeholder={t('namePlaceholder')} onChange={(event) => setField('name', event.target.value)} disabled={!!c.busy || active} /></div>
        <div className="field"><label htmlFor="base-url">{t('baseUrl')}</label><input id="base-url" type="url" spellCheck={false} value={draft.baseUrl} placeholder={t('baseUrlPlaceholder')} onChange={(event) => setField('baseUrl', event.target.value)} disabled={!!c.busy || active} /></div>
        <div className="field"><div className="field-label"><label htmlFor="api-key">{t('apiKey')}</label>{profile?.hasApiKey && !clearKey && <span className="saved-key-label"><Check size={11} />{t('keySaved')}</span>}</div><div className="input-wrap"><input id="api-key" type={showKey ? 'text' : 'password'} value={key} autoComplete="off" spellCheck={false} placeholder={profile?.hasApiKey && !clearKey ? t('keyStoredPlaceholder') : t('apiKeyPlaceholder')} onChange={(event) => { setKey(event.target.value); setConnection(null); if (event.target.value) setClearKey(false); }} disabled={!!c.busy || active} /><button type="button" className="input-action" aria-label={t(showKey ? 'hideKey' : 'showKey')} title={t(showKey ? 'hideKey' : 'showKey')} onClick={() => setShowKey(!showKey)} disabled={active}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>{clearKey ? <p className="field-hint key-removal">{t('removePending')}<button onClick={() => setClearKey(false)}>{t('undo')}</button></p> : profile?.hasApiKey && <div className="key-hint-row"><span className="field-hint">{t('savedKeyHint')}</span><button className="text-button danger-text" disabled={!!c.busy || active} onClick={() => { setClearKey(true); setKey(''); setConnection(null); }}><Trash2 size={11} />{t('removeKey')}</button></div>}</div>
        {!state.encryptionAvailable && <p className="field-warning"><CircleAlert size={13} />{t('noEncryption')}</p>}
        <div className="discovery-row"><button className="button secondary test-button" disabled={c.disabled || !draft.baseUrl.trim() || !keyAvailable} onClick={() => void discovered()}>{c.busy === 'test' ? <LoaderCircle size={14} className="spin" /> : <Zap size={14} />}{c.busy === 'test' ? t('testing') : t('test')}</button><span>{models.length ? t('modelsCount', { count: models.length }) : t('discoveryHint')}</span></div>
        {connection && <div className={`connection-result ${connection.ok ? 'success' : 'error'}`} role={connection.ok ? 'status' : 'alert'}>{connection.ok ? <CircleCheck size={14} /> : <CircleAlert size={14} />}<span>{t(connection.ok ? 'testOk' : 'testFailed')}{connection.ok && connection.models?.length ? ` · ${t('discovered', { count: connection.models.length })}` : ''}<small>{connection.latencyMs} ms</small>{!connection.ok && <span className="connection-error">{friendlyError(connection.error, state.settings.language)}</span>}</span></div>}
        {models.length > 0 && <div className="discovered-models">{models.slice(0, 6).map((model) => <span key={model}><CircleDot size={9} />{model}</span>)}{models.length > 6 && <span>+{models.length - 6}</span>}</div>}
      </section>
      <section className={`advanced-section ${advanced ? 'open' : ''}`}><button className="advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><Settings2 size={14} /><span>{t('advanced')}</span><ChevronDown size={15} /></button>{advanced && <div className="advanced-body">
        <div className="field"><label htmlFor="protocol">{t('protocol')}</label><select id="protocol" value={draft.protocol} onChange={(event) => setField('protocol', event.target.value as ApiProtocol)} disabled={!!c.busy || active}><option value="auto">{t('protocolAuto')}</option><option value="responses">{t('protocolResponses')}</option><option value="chat_completions">{t('protocolChat')}</option></select><p className="field-hint">{t('protocolHint')}</p></div>
        <div className="field"><label htmlFor="model-ids">{t('models')}</label><textarea id="model-ids" value={draft.modelsText} spellCheck={false} placeholder={t('modelsPlaceholder')} onChange={(event) => { const ids = modelIds(event.target.value); setDraft((old) => ({ ...old, modelsText: event.target.value, defaultModel: ids.includes(old.defaultModel) ? old.defaultModel : '' })); }} disabled={!!c.busy || active} rows={4} /><p className="field-hint">{t('modelsHint')}</p></div>
        <div className="field"><label htmlFor="default-model">{t('defaultModel')}</label><select id="default-model" value={draft.defaultModel} disabled={!!c.busy || active || !models.length} onChange={(event) => setField('defaultModel', event.target.value)}><option value="">{t('automaticDefault')}</option>{models.map((model) => <option key={model} value={model}>{model}</option>)}</select><p className="field-hint">{t('defaultHint')}</p></div>
      </div>}</section>
      <p className="security-note"><LockKeyhole size={13} />{t('securityNote')}</p>
    </div>
    <div className="editor-save-bar"><div>{profile ? <button className="text-button delete-profile" disabled={c.disabled || active} onClick={() => c.confirm({ kind: 'delete', profile, onDeleted })}><Trash2 size={13} />{t('deleteProfile')}</button> : <span className="save-status"><ShieldCheck size={12} />{t('localOnly')}</span>}</div><span className={`save-status ${dirty ? 'dirty' : ''}`}><span className="tiny-dot" />{t(dirty ? 'unsaved' : profile ? 'savedState' : 'readyToSave')}</span><button className="button primary" disabled={c.disabled || active || !valid || !!profile && !dirty} onClick={() => void save()}>{c.busy === 'save-profile' ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{t(c.busy === 'save-profile' ? 'saving' : 'saveProfile')}</button></div>
  </section>;
}

function generalSignature(settings: Settings): string { return JSON.stringify([settings.codexHome, settings.codexAppPath, settings.launchAtLogin]); }
function GeneralSettings({ controller: c, onDirty }: { controller: Controller; onDirty: (value: boolean) => void }) {
  const { state, t } = c;
  const [draft, setDraft] = useState(state.settings);
  const dirty = generalSignature(draft) !== generalSignature(state.settings);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const choose = async (field: 'codexHome' | 'codexAppPath') => c.run('browse', async () => { const value = field === 'codexHome' ? await api!.chooseCodexHome() : await api!.chooseCodexApp(); if (value !== null) setDraft((old) => ({ ...old, [field]: value })); });
  const save = async () => c.run('settings', async () => {
    const next = await api!.saveSettings({ ...state.settings, codexHome: draft.codexHome, codexAppPath: draft.codexAppPath, launchAtLogin: draft.launchAtLogin, hideOnBlur: false });
    c.setState(next); setDraft(next.settings); c.report({ kind: 'success', text: t('settingsSaved') });
  });
  return <section className="editor-column"><div className="editor-scroll"><div className="editor-heading"><div><div className="eyebrow">{t('settings')}</div><h1>{t('general')}</h1><p>{t('generalSubtitle')}</p></div><span className="heading-icon"><Settings2 size={22} /></span></div>
    <section className="settings-section"><div className="settings-section-heading"><Terminal size={15} /><h2>{t('appLocation')}</h2>{state.detectedAppPath && !draft.codexAppPath && <span className="detected-label"><Check size={11} />{t('autoDetected')}</span>}</div>
      <div className="field"><label htmlFor="app-path">{t('appPath')}</label><div className="browse-field"><input id="app-path" value={draft.codexAppPath} placeholder={state.detectedAppPath || t('appPathPlaceholder')} onChange={(event) => setDraft((old) => ({ ...old, codexAppPath: event.target.value }))} disabled={!!c.busy} /><button className="browse-button" disabled={c.disabled} onClick={() => void choose('codexAppPath')}><FolderOpen size={13} />{t('browse')}</button></div></div>
      <div className="field"><label htmlFor="codex-home">{t('codexHome')}</label><div className="browse-field"><input id="codex-home" value={draft.codexHome} onChange={(event) => setDraft((old) => ({ ...old, codexHome: event.target.value }))} disabled={!!c.busy} /><button className="browse-button" disabled={c.disabled} onClick={() => void choose('codexHome')}><FolderOpen size={13} />{t('browse')}</button></div><p className="field-hint">{t('codexHomeHint')}</p></div>
    </section>
    <section className="settings-section general-section"><div className="settings-section-heading"><Settings2 size={15} /><h2>{t('behavior')}</h2></div>
      <div className="preference-row"><div><label id="launch-label">{t('launchAtLogin')}</label><p>{t('launchAtLoginHint')}</p></div><Toggle label={t('launchAtLogin')} checked={draft.launchAtLogin} disabled={c.disabled} onChange={(value) => setDraft((old) => ({ ...old, launchAtLogin: value }))} /></div>
      <div className="preference-row language-row"><label htmlFor="display-language">{t('displayLanguage')}</label><select id="display-language" value={state.settings.language} disabled={!!c.busy} onChange={(event) => void c.changeLanguage(event.target.value as Language)}><option value="zh-CN">简体中文</option><option value="en">English</option></select></div>
    </section><UpdateSettings controller={c} dirty={dirty} /><p className="security-note"><LockKeyhole size={13} />{t('securityNote')}</p>
  </div><div className="editor-save-bar"><span className={`save-status ${dirty ? 'dirty' : ''}`}><span className="tiny-dot" />{t(dirty ? 'unsaved' : 'savedState')}</span><button className="button primary" disabled={c.disabled || !dirty} onClick={() => void save()}>{c.busy === 'settings' ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{t(c.busy === 'settings' ? 'saving' : 'saveSettings')}</button></div></section>;
}

function UpdateSettings({ controller: c, dirty }: { controller: Controller; dirty: boolean }) {
  const { t } = c;
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [pending, setPending] = useState<'check' | 'download' | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const mounted = useRef(true);
  const pendingAction = useRef(false);
  const lastOperation = useRef<'check' | 'download' | null>(null);
  useEffect(() => {
    mounted.current = true;
    if (!api) return () => { mounted.current = false; };
    let receivedPush = false;
    const unsubscribe = api.onUpdateStateChanged((next) => {
      receivedPush = true;
      setUpdate(next); setLocalError(null);
    });
    void api.getUpdateState().then((next) => {
      if (mounted.current && !receivedPush) setUpdate(next);
    }).catch((error) => { if (mounted.current) setLocalError(error instanceof Error ? error.message : 'UPDATE_CHECK_FAILED'); });
    return () => { mounted.current = false; unsubscribe(); };
  }, []);
  const run = async (action: 'check' | 'download') => {
    if (!api || pendingAction.current) return;
    lastOperation.current = action;
    pendingAction.current = true; setPending(action); setLocalError(null);
    try {
      const next = await (action === 'check' ? api.checkForUpdates() : api.downloadUpdate());
      if (mounted.current) setUpdate(next);
    } catch (error) {
      if (mounted.current) setLocalError(error instanceof Error ? error.message : action === 'check' ? 'UPDATE_CHECK_FAILED' : 'UPDATE_DOWNLOAD_FAILED');
    } finally {
      pendingAction.current = false;
      if (mounted.current) setPending(null);
    }
  };
  const install = () => c.run('install-update', async () => {
    setLocalError(null);
    try {
      const next = await api!.installUpdate();
      if (mounted.current) setUpdate(next);
    } catch (error) {
      if (mounted.current) setLocalError(error instanceof Error ? error.message : 'UPDATE_INSTALL_FAILED');
    }
  });
  const openRelease = async () => {
    try { await api!.openUpdateRelease(); }
    catch (error) { if (mounted.current) setLocalError(error instanceof Error ? error.message : 'UPDATE_CHECK_FAILED'); }
  };
  const status = update?.status ?? 'idle';
  const busy = !!pending || ['checking', 'downloading', 'installing'].includes(status);
  const error = localError || update?.error;
  const retryDownload = !!error && (/UPDATE_(DOWNLOAD|CHECKSUM|INVALID_CHECKSUM|SIZE|CANCELLED)/.test(error) || error === 'UPDATE_TIMEOUT' && lastOperation.current === 'download');
  const canDownload = status === 'available' || status === 'error' && retryDownload;
  const canInstall = status === 'downloaded' || status === 'installing';
  const progress = update && update.totalBytes > 0 ? Math.min(100, Math.max(0, Math.round(update.downloadedBytes / update.totalBytes * 100))) : null;
  const transfer = (bytes: number) => new Intl.NumberFormat(c.state.settings.language, { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024);
  return <section className="settings-section update-section" aria-labelledby="app-update-title">
    <div className="settings-section-heading"><Download size={15} /><h2 id="app-update-title">{t('appUpdates')}</h2>{status === 'up-to-date' && <span className="update-current"><CircleCheck size={12} />{t('updateLatest')}</span>}</div>
    <p className="update-source">{t('updateSource')}</p>
    <dl className="update-versions"><div><dt>{t('currentVersion')}</dt><dd>v{update?.currentVersion ?? c.state.version}</dd></div>{update?.latestVersion && <div><dt>{t('latestVersion')}</dt><dd>v{update.latestVersion}</dd></div>}</dl>
    <p className="update-status" role="status">{t(status === 'checking' ? 'checkingUpdates' : status === 'available' ? 'updateAvailable' : status === 'downloading' ? 'downloadingUpdate' : status === 'downloaded' ? 'updateReady' : status === 'installing' ? 'installingUpdate' : status === 'up-to-date' ? 'updateLatestHint' : 'updateCheckHint', { version: update?.latestVersion ?? '' })}</p>
    {status === 'downloading' && <div className="update-progress"><progress max="100" value={progress ?? undefined} aria-label={t('updateProgress')} /><span>{progress === null ? `${transfer(update?.downloadedBytes ?? 0)} MB` : `${progress}% · ${transfer(update?.downloadedBytes ?? 0)} / ${transfer(update?.totalBytes ?? 0)} MB`}</span></div>}
    {error && <div className="update-error" role="alert"><CircleAlert size={14} /><span>{friendlyError(error, c.state.settings.language)}</span></div>}
    {update?.releaseNotes && <details className="update-notes"><summary>{t('updateNotes')}</summary><p>{update.releaseNotes}</p></details>}
    {api && update && !update.canInstall && <p className="update-hint">{t('updateInstallUnavailable')}</p>}
    {!api && <p className="update-hint">{t('updateDesktopOnly')}</p>}
    {canInstall && dirty && <p className="update-hint update-unsaved">{t('updateSaveFirst')}</p>}
    {(canDownload || canInstall) && update?.canInstall && <p className="update-hint">{t('updateRestartHint')}</p>}
    <div className="update-actions">
      <button className="button secondary" disabled={!api || busy} onClick={() => void run('check')}>{status === 'checking' || pending === 'check' ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}{t(status === 'checking' || pending === 'check' ? 'checkingUpdates' : error && !retryDownload && !canInstall ? 'retry' : 'checkUpdates')}</button>
      {canDownload && <button className="button primary" disabled={!api || busy || !update?.canInstall} onClick={() => void run('download')}><Download size={13} />{t(retryDownload ? 'retryDownloadUpdate' : 'downloadUpdate')}</button>}
      {canInstall && <button className="button primary" disabled={c.disabled || busy || dirty || !update?.canInstall} onClick={() => void install()}>{status === 'installing' ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}{t(status === 'installing' ? 'installingUpdate' : 'installUpdate')}</button>}
      {api && <button className="text-button" onClick={() => void openRelease()}>{t('viewRelease')}<ExternalLink size={12} /></button>}
    </div>
  </section>;
}

function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" className={`toggle ${checked ? 'on' : ''}`} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} disabled={disabled}><span /></button>;
}

function ConfirmDialog({ value, t, onCancel, onConfirm }: { value: Confirmation; t: Translate; onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
      if (event.key === 'Tab') {
        const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        if (!buttons?.length) return;
        const first = buttons[0]!; const last = buttons[buttons.length - 1]!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => { window.removeEventListener('keydown', keyboard); previous?.focus(); };
  }, [onCancel]);
  const title = value.kind === 'switch' ? t('switchTitle', { name: value.name }) : value.kind === 'delete' ? t('deleteTitle', { name: value.profile.name }) : t(value.kind === 'restart' ? 'restartTitle' : value.kind === 'quit' ? 'quitTitle' : 'discardTitle');
  const description = t(value.kind === 'switch' ? 'switchWarning' : value.kind === 'delete' ? 'deleteWarning' : value.kind === 'restart' ? 'restartWarning' : value.kind === 'quit' ? 'quitWarning' : 'discardWarning');
  return <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}><div className="confirmation-modal" ref={dialog} role="alertdialog" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-description"><div className="modal-icon">{value.kind === 'delete' ? <Trash2 size={22} /> : value.kind === 'quit' ? <Power size={22} /> : <RefreshCw size={22} />}</div><h2 id="confirmation-title">{title}</h2><p id="confirmation-description">{description}</p>{value.kind === 'switch' && <p className="modal-detail">{value.id === 'chatgpt' ? t('switchNative') : t('switchApi', { name: value.name })}</p>}<div className="modal-actions"><button ref={cancel} className="button secondary" onClick={onCancel}>{t('cancel')}</button><button className={`button ${value.kind === 'delete' ? 'danger' : 'primary'}`} onClick={onConfirm}>{t(value.kind === 'switch' ? 'confirmSwitch' : value.kind === 'delete' ? 'confirmDelete' : value.kind === 'restart' ? 'confirmRestart' : value.kind === 'discard' ? 'discard' : 'quit')}<ArrowRight size={14} /></button></div></div></div>;
}

export default App;
