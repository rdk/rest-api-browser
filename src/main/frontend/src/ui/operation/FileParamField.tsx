import { useEffect, useRef, useState } from 'preact/hooks';
import type { Param } from '../../core/types';
import { tipProps } from '../../core/uitips';
import type { Check } from '../../core/validate';
import { CheckMark, formatBytes } from '../bits';

/** A multipart FilePart field: file picker by default, with a quiet switch to text that syncs across history/undo. */
export function FileParamField({ param, files, textValues, onFiles, onText }: {
  param: Param; files: File[]; textValues: string[]; onFiles: (f: File[]) => void; onText: (v: string[]) => void;
}) {
  const hasFiles = files.length > 0;
  const hasText = textValues.some((v) => v.trim() !== '');
  const [asText, setAsText] = useState(() => !hasFiles && hasText);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!hasFiles && hasText) setAsText(true);
    else if (hasFiles) setAsText(false);
  }, [hasFiles, hasText]);

  useEffect(() => {
    if (!hasFiles && inputRef.current) inputRef.current.value = '';
  }, [hasFiles]);

  const label = `${param.name} (multipart form parameter${param.required ? ', required' : ''})`;
  const switchMode = () => {
    if (asText) {
      onText(['']);
      setAsText(false);
    } else {
      if (files.length) onFiles([]);
      if (inputRef.current) inputRef.current.value = '';
      setAsText(true);
    }
  };
  if (asText) {
    const val = textValues[0] ?? '';
    const textCheck: Check = val.trim() ? { state: 'ok', message: 'Valid text value' }
      : param.required ? { state: 'warn', message: 'Required' } : null;
    const textInvalid = !!param.required && !val.trim();
    return (
      <div class="rab-n-param-row">
        <input class={'rab-n-input' + (textInvalid ? ' is-warn' : '')} name={param.name} aria-label={label}
               aria-invalid={textInvalid ? 'true' : undefined} value={val} placeholder="text part"
               onInput={(e) => onText([(e.target as HTMLInputElement).value])} />
        <CheckMark check={textCheck} />
        <button type="button" class="rab-n-quiet" onClick={switchMode}
                {...tipProps({ title: 'Switch to file upload', body: 'Upload a file for this multipart form part instead of sending plain text.' })}>File</button>
      </div>
    );
  }
  const check: Check = files.length > 0 ? { state: 'ok', message: `${files.length} file${files.length === 1 ? '' : 's'} selected` }
    : param.required ? { state: 'warn', message: 'Required' } : null;
  return (
    <div class="rab-n-file-field">
      <div class="rab-n-param-row">
        <input
          ref={inputRef}
          class="rab-n-file-input"
          type="file"
          name={param.name}
          multiple={!!param.repeating}
          aria-label={label}
          onChange={(e) => onFiles([...((e.target as HTMLInputElement).files ?? [])])}
        />
        <CheckMark check={check} />
        {files.length > 0 && (
          <button type="button" class="rab-n-icon" aria-label={`Clear ${param.name}`}
                  {...tipProps({ title: 'Clear files', body: 'Remove the selected file(s) from this multipart upload field.' })}
                  onClick={() => { onFiles([]); if (inputRef.current) inputRef.current.value = ''; }}>×</button>
        )}
        <button type="button" class="rab-n-quiet" onClick={switchMode}
                {...tipProps({ title: 'Switch to plain text', body: 'Send a text value for this multipart part instead of uploading a file.' })}>Text</button>
      </div>
      {files.length > 0 && (
        <div class="rab-n-file-list">
          {files.map((f, i) => <span key={i} class="rab-n-file-chip">{f.name} ({formatBytes(f.size)})</span>)}
        </div>
      )}
    </div>
  );
}
