import { ArrowDownToLine, Check, DatabaseBackup, HardDrive, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, gradientOf } from '../../components/Avatar';
import { Button } from '../../components/ui/Button';
import { PageHeader } from '../../components/ui/PageHeader';
import { plural, timeAgo } from '../../lib/format';
import { formatBytes, requestPersistenceNow, storageStatus, type StorageStatus } from '../../lib/persist';
import { useDatasets } from '../../state/useDatasets';
import { AVATAR_COLORS } from '../../state/useProfile';
import { useWorkspace } from '../../state/WorkspaceContext';
import './ProfilePage.css';

export function ProfilePage() {
  const { profile, updateProfile, flows, knowledge, ollama, exportWorkspace, restoreWorkspace, lastBackupAt } = useWorkspace();
  const { items: datasets, refresh: refreshDatasets } = useDatasets();
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [storageNote, setStorageNote] = useState('');
  const refreshStorage = useCallback(() => { void storageStatus().then(setStorage); }, []);
  useEffect(refreshStorage, [refreshStorage]);

  const keepMyData = async () => {
    const granted = await requestPersistenceNow();
    setStorageNote(granted ? '' : 'The browser did not agree. That is normal for a site you have only just started using, so keep a backup.');
    refreshStorage();
  };
  const fileRef = useRef<HTMLInputElement>(null);
  const steps = flows.reduce((sum, f) => sum + f.nodes.length, 0);
  const importedCount = knowledge.filter(k => k.imported).length;

  return (
    <div className="page">
      <PageHeader
        title="Profile"
        description="Your name and avatar appear in the sidebar and the greeting. Everything here is stored in this browser only."
      />

      <div className="profile">
        <section className="profile__card card">
          <div className="profile__hero">
            <Avatar name={profile.name} color={profile.color} size={84} />
            <div>
              <h2>{profile.name.trim() || 'Unnamed'}</h2>
              <p>{profile.role.trim() || 'No role set'}</p>
            </div>
          </div>

          <div className="profile__form">
            <div className="field">
              <label className="field__label" htmlFor="pf-name">Display name</label>
              <input id="pf-name" className="input" value={profile.name} maxLength={40} onChange={e => updateProfile({ name: e.target.value })} />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="pf-role">Role or project</label>
              <input id="pf-role" className="input" value={profile.role} maxLength={60} onChange={e => updateProfile({ role: e.target.value })} />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="pf-email">Email <span className="field__hint">(optional)</span></label>
              <input id="pf-email" type="email" className="input" value={profile.email} placeholder="you@example.com" onChange={e => updateProfile({ email: e.target.value })} />
              <span className="field__hint">Kept on this device. It is never sent anywhere.</span>
            </div>

            <div className="field">
              <span className="field__label" id="pf-color">Avatar colour</span>
              <div className="swatches" role="radiogroup" aria-labelledby="pf-color">
                {AVATAR_COLORS.map(c => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={profile.color === c}
                    aria-label={c}
                    className="swatch"
                    style={{ background: gradientOf(c) }}
                    onClick={() => updateProfile({ color: c })}
                  >
                    {profile.color === c && <Check size={16} />}
                  </button>
                ))}
              </div>
            </div>
            <p className="profile__saved"><Check size={14} aria-hidden /> Changes save automatically.</p>
          </div>
        </section>

        <div className="profile__side">
          <section className="card profile__panel">
            <h3>Your workspace</h3>
            <dl className="profile__stats">
              <div><dt>Workflows</dt><dd>{flows.length}</dd></div>
              <div><dt>Total steps</dt><dd>{steps}</dd></div>
              <div><dt>Datasets</dt><dd>{datasets ? datasets.length : '–'}</dd></div>
              <div><dt>Knowledge entries</dt><dd>{knowledge.length}</dd></div>
              <div><dt>Imported</dt><dd>{importedCount}</dd></div>
            </dl>
            <p className="profile__model">AI model: <b>{ollama.modelName}</b> ({ollama.status === 'online' ? 'connected' : 'not connected'})</p>
          </section>

          <section className="card profile__panel">
            <h3><DatabaseBackup size={18} aria-hidden /> Backup</h3>
            <p>Download {plural(flows.length, 'workflow')}, {datasets ? plural(datasets.length, 'dataset') : 'your datasets'}, your imported knowledge and this profile as one file. Restore it later or on another browser.</p>
            <p className={`profile__backup ${lastBackupAt ? '' : 'is-never'}`}>{lastBackupAt ? `Last backup: ${timeAgo(lastBackupAt)}.` : 'You have not made a backup yet.'}</p>
            <div className="profile__actions">
              <Button icon={<ArrowDownToLine size={16} />} onClick={() => void exportWorkspace()}>Download backup</Button>
              <Button icon={<Upload size={16} />} onClick={() => fileRef.current?.click()}>Restore…</Button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={e => {
                const file = e.target.files?.[0];
                if (file) void restoreWorkspace(file).then(refreshDatasets);
                e.currentTarget.value = '';
              }}
            />
            <p className="profile__warn">Restoring replaces your current workflows and imported knowledge. Datasets in the backup are added; one with the same name replaces yours, and your other datasets are kept.</p>
          </section>

          <section className="card profile__panel">
            <h3><HardDrive size={18} aria-hidden /> Browser storage</h3>
            <p>
              Your workflows and data live only in this browser. Browsers can clear a site's data when the device is short of space, and clearing your browsing data deletes it.
              {storage?.persisted === true && ' This browser has agreed to keep it.'}
              {storage?.persisted === false && ' This browser has not promised to keep it.'}
              {storage?.persisted === null && ' This browser cannot say whether it will keep it.'}
            </p>
            {storage?.usage != null && <p className="profile__warn">Using {formatBytes(storage.usage)}{storage.quota ? ` of about ${formatBytes(storage.quota)} available` : ''}.</p>}
            {storage?.persisted === false && (
              <div className="profile__actions"><Button onClick={() => void keepMyData()}>Ask the browser to keep my data</Button></div>
            )}
            {storageNote && <p className="profile__warn" role="status">{storageNote}</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
