import {useEffect,useRef,useState} from 'react';
import {getSettings,saveSettings,type Settings} from './native';
export function SettingsDialog({onClose}:{onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [settings,setSettings]=useState<Settings|null>(null);
  const [error,setError]=useState('');
  const [saving,setSaving]=useState(false);
  useEffect(()=>{dialog.current?.showModal();void getSettings().then(setSettings).catch(error=>setError(String(error)));},[]);
  useEffect(()=>{
    const requested=()=>setError('Save or cancel settings before quitting.');
    window.addEventListener('enchiridion-quit-requested',requested);
    return()=>window.removeEventListener('enchiridion-quit-requested',requested);
  },[]);
  return <dialog ref={dialog} className="settings-dialog" onCancel={event=>{event.preventDefault();if(!saving)onClose();}}>
    <form onSubmit={async event=>{event.preventDefault();if(!settings)return;setSaving(true);try{await saveSettings(settings);onClose();}catch(error){setError(String(error));}finally{setSaving(false);}}}>
      <h2>Settings</h2>
      {settings&&<><label>Your name<input autoFocus value={settings.displayName} onChange={event=>setSettings({...settings,displayName:event.target.value})}/></label>
      <label className="check-label"><input type="checkbox" checked={settings.showMenuBarItem} onChange={event=>setSettings({...settings,showMenuBarItem:event.target.checked})}/>Show menu bar item</label></>}
      <p className="muted">Preferences are saved on this device.</p>
      {error&&<p role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" disabled={saving} onClick={onClose}>Cancel</button><button className="primary" disabled={!settings||saving}>{saving?'Saving…':'Done'}</button></div>
    </form>
  </dialog>;
}
