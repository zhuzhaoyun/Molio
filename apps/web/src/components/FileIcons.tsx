/**
 * @ file-ref icons: emoji glyph + a small colored corner dot.
 *
 * Emoji (📁/📄) are the richest-looking glyphs available and render crisply
 * at small sizes, but their colors are fixed and too similar to tell apart at
 * a glance. Rather than replace them with flatter line icons, we keep the
 * emoji and add a saturated corner dot as a color signal:
 *  - Folder: amber dot (warm).
 *  - File: blue dot (cool).
 *
 * The dot is small enough not to crowd the glyph, but the warm-vs-cool contrast
 * gives an immediate read regardless of how the platform renders the emoji.
 */

interface RefIconProps {
  size?: number;
}

function RefIcon({ emoji, dotColor, size = 16 }: RefIconProps & { emoji: string; dotColor: string }) {
  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
      }}
    >
      <span style={{ fontSize: size, lineHeight: 1 }}>{emoji}</span>
      <span
        style={{
          position: 'absolute',
          right: -1,
          bottom: -1,
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: dotColor,
          border: '1.5px solid var(--bg-panel)',
          boxSizing: 'border-box',
        }}
      />
    </span>
  );
}

export function FolderIcon({ size = 16 }: RefIconProps) {
  return <RefIcon emoji="📁" dotColor="#e8a33d" size={size} />;
}

export function FileDocIcon({ size = 15 }: RefIconProps) {
  return <RefIcon emoji="📄" dotColor="#4a6cf7" size={size} />;
}
