/**
 * 副视图文件的独立取数 hook。主格内容由 useKnowledge 管理（跟随 activeTabId）；
 * 副格文件不在标签系统里，必须自取。cancelled-flag 防竞态（api.readFile 不支持 abort）。
 */
import { useEffect, useState } from 'react';
import type { FileContent } from '@molio/contracts';
import { api } from '../api/client';

export function useCompanionFile(vaultId: string | null, filePath: string | null): {
  fileContent: FileContent | null;
  error: string | null;
  loading: boolean;
} {
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!vaultId || !filePath) {
      setFileContent(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.readFile(vaultId, filePath)
      .then((fc) => {
        if (cancelled) return;
        setFileContent(fc);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setFileContent(null);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [vaultId, filePath]);

  return { fileContent, error, loading };
}
