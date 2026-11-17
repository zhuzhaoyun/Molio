/**
 * @ file-ref icons: shared line icons with a warm/cool color signal.
 *
 * Folder = amber (warm), file = blue (cool). The color carries the distinction
 * that used to be done with an emoji + corner dot; the glyph itself now comes
 * from the same line-icon set as the rest of the UI, so weight, baseline and
 * theme response are consistent everywhere.
 */

import { FileIcon, FolderIcon as FolderLineIcon } from './icons';
import './FileIcons.css';

interface RefIconProps {
  size?: number;
}

export function FolderIcon({ size = 16 }: RefIconProps) {
  return (
    <span className="file-icon--folder" aria-hidden="true">
      <FolderLineIcon size={size} />
    </span>
  );
}

export function FileDocIcon({ size = 15 }: RefIconProps) {
  return (
    <span className="file-icon--doc" aria-hidden="true">
      <FileIcon size={size} />
    </span>
  );
}
