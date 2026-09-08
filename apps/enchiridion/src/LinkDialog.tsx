import {useEffect,useRef,useState} from 'react';
export function LinkDialog({initial,onSave,onClose}:{initial:string;onSave:(url:string)=>void;onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [url,setURL]=useState(initial);
  const [error,setError]=useState('');
  useEffect(()=>{dialog.current?.showModal();},[]);
  return <dialog ref={dialog} className="settings-dialog" onCancel={event=>{event.preventDefault();onClose();}}>
    <form onSubmit={event=>{event.preventDefault();try{if(url&&!['https:','http:','mailto:'].includes(new URL(url).protocol))throw new Error();onSave(url);}catch{setError('Use an https, http, or mailto link.');}}}>
      <h2>Link</h2><label>Address<input type="text" autoFocus value={url} onChange={event=>setURL(event.target.value)} placeholder="https://"/></label>
      {error&&<p role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary">{url?'Apply':'Remove link'}</button></div>
    </form>
  </dialog>;
}
