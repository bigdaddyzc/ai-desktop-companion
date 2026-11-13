import { useState, type DragEvent } from 'react';
import type { AttachmentInfo } from '../core/attachments';

/**
 * 把文件拖进窗口：取本机路径交给主进程复制进沙盒，回来的是附件信息。
 * 不拦 dragover 的话，Electron 默认会把拖进来的文件当网页打开。
 */
export function useFileDrop(
  onAttached: (items: AttachmentInfo[]) => void,
  onError: (error: string) => void,
) {
  const [dragging, setDragging] = useState(false);
  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');
  return {
    dragging,
    handlers: {
      onDragOver(event: DragEvent) {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      },
      onDragLeave(event: DragEvent) {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      },
      onDrop(event: DragEvent) {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDragging(false);
        const paths = Array.from(event.dataTransfer.files)
          .map((file) => window.companion!.pathForFile(file))
          .filter((path) => path !== '');
        if (paths.length === 0) {
          onError('没拿到文件路径：只能拖本机文件。');
          return;
        }
        void window
          .companion!.attachPaths(paths)
          .then((result) => (result.ok ? onAttached(result.items) : onError(result.error)))
          .catch(() => onError('文件没收下。'));
      },
    },
  };
}
