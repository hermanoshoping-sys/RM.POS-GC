import { downloadTextFile } from './export';

const HANDLE_DB_NAME = 'MatjarProFSHandles';
const HANDLE_STORE = 'handles';
const BACKUP_DIR_KEY = 'externalBackupDir';

export interface ExternalDirectoryHandleLike {
  name: string;
  queryPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<'granted' | 'denied' | 'prompt'>;
  getFileHandle: (
    name: string,
    options?: { create?: boolean }
  ) => Promise<{
    createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>;
    getFile: () => Promise<File>;
  }>;
}

export function isDirectoryPickerSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
  );
}

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(HANDLE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open handle store'));
  });
}

async function storeDirectoryHandle(handle: ExternalDirectoryHandleLike): Promise<void> {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).put(handle, BACKUP_DIR_KEY);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error('Failed to store directory handle'));
    };
  });
}

export async function getSavedBackupDirectoryHandle(): Promise<ExternalDirectoryHandleLike | null> {
  try {
    const db = await openHandleDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get(BACKUP_DIR_KEY);
      req.onsuccess = () => {
        db.close();
        resolve((req.result as ExternalDirectoryHandleLike | undefined) ?? null);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch {
    return null;
  }
}

export async function clearSavedBackupDirectoryHandle(): Promise<void> {
  try {
    const db = await openHandleDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).delete(BACKUP_DIR_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    // Ignore cleanup errors
  }
}

export async function pickExternalBackupDirectory(): Promise<{
  name: string;
  handle: ExternalDirectoryHandleLike;
}> {
  if (!isDirectoryPickerSupported()) {
    throw new Error(
      'متصفحك لا يدعم اختيار مجلد خارجي (showDirectoryPicker) — سيتم استخدام التنزيل اليومي كبديل'
    );
  }
  const picker = (
    window as unknown as {
      showDirectoryPicker: (opts?: {
        id?: string;
        mode?: 'read' | 'readwrite';
      }) => Promise<ExternalDirectoryHandleLike>;
    }
  ).showDirectoryPicker;

  const handle = await picker({ id: 'rmpos-gc-backups', mode: 'readwrite' });
  await storeDirectoryHandle(handle);
  return { name: handle.name, handle };
}

export async function ensureDirectoryPermission(
  handle: ExternalDirectoryHandleLike,
  interactive = false
): Promise<boolean> {
  try {
    const perm = handle.queryPermission
      ? await handle.queryPermission({ mode: 'readwrite' })
      : 'granted';
    if (perm === 'granted') return true;
    if (interactive && handle.requestPermission) {
      const req = await handle.requestPermission({ mode: 'readwrite' });
      return req === 'granted';
    }
    return false;
  } catch {
    return false;
  }
}

export async function writeBackupToExternalDirectory(
  fileName: string,
  content: string,
  interactive = false
): Promise<{ written: boolean; folderName?: string }> {
  const handle = await getSavedBackupDirectoryHandle();
  if (!handle) return { written: false };

  const ok = await ensureDirectoryPermission(handle, interactive);
  if (!ok) return { written: false };

  try {
    const fileHandle = await handle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    return { written: true, folderName: handle.name };
  } catch {
    return { written: false };
  }
}

export async function readBackupFromExternalDirectory(
  fileName: string,
  interactive = true
): Promise<string | null> {
  const handle = await getSavedBackupDirectoryHandle();
  if (!handle) return null;

  const ok = await ensureDirectoryPermission(handle, interactive);
  if (!ok) return null;

  try {
    const fileHandle = await handle.getFileHandle(fileName, { create: false });
    const file = await fileHandle.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

export async function saveBackupExternally(
  fileName: string,
  content: string,
  options: { interactive?: boolean; allowDownloadFallback?: boolean; forceDownload?: boolean } = {}
): Promise<{
  storageLocation: 'directory' | 'download';
  folderName?: string;
  fileName: string;
}> {
  const { interactive = false, allowDownloadFallback = true, forceDownload = false } = options;

  if (!forceDownload) {
    const dirRes = await writeBackupToExternalDirectory(fileName, content, interactive);
    if (dirRes.written) {
      return {
        storageLocation: 'directory',
        folderName: dirRes.folderName,
        fileName,
      };
    }
  }

  if (allowDownloadFallback && typeof document !== 'undefined' && typeof URL !== 'undefined') {
    try {
      downloadTextFile(content, fileName);
    } catch {
      // Ignore DOM download errors in headless test environments
    }
  }

  return {
    storageLocation: 'download',
    fileName,
  };
}
