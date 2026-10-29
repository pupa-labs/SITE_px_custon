import React, { useState } from 'react';
import { OFFICIAL_LOGO_ORIGINAL, OFFICIAL_LOGO_TRANSPARENT } from '../services/platformService';

interface BrandLogoProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  useSolidOriginal?: boolean;
}

/**
 * Renders the official user-provided PX CUSTON logo without redrawing or replacing it.
 * Uses the transparent trimmed version of /assets/aistudio/IMG-20261005-WA0172_fd0eb16e.jpg
 * with automatic fallback to the raw original file.
 */
export const BrandLogo: React.FC<BrandLogoProps> = ({
  size = 'md',
  className = '',
  useSolidOriginal = false,
}) => {
  const [src, setSrc] = useState(
    useSolidOriginal ? OFFICIAL_LOGO_ORIGINAL : OFFICIAL_LOGO_TRANSPARENT
  );

  const heightClasses = {
    sm: 'h-8',
    md: 'h-10 sm:h-11',
    lg: 'h-14 sm:h-16',
    xl: 'h-20 sm:h-24',
  }[size];

  return (
    <img
      src={src}
      alt="PX CUSTON — Plataforma Oficial de Eventos Automotivos"
      referrerPolicy="no-referrer"
      onError={() => {
        if (src !== OFFICIAL_LOGO_ORIGINAL) {
          setSrc(OFFICIAL_LOGO_ORIGINAL);
        }
      }}
      className={`${heightClasses} w-auto object-contain select-none ${className}`}
    />
  );
};

interface ResilientImageProps {
  src: string;
  alt: string;
  className?: string;
}

export const ResilientImage: React.FC<ResilientImageProps> = ({ src, alt, className = '' }) => {
  const [hasError, setHasError] = useState(false);

  if (hasError) {
    return (
      <div
        className={`flex flex-col items-center justify-center bg-gradient-to-br from-[#14161D] via-[#0D0E12] to-[#26070A] text-neutral-400 p-4 text-center ${className}`}
      >
        <BrandLogo size="sm" />
        <span className="mt-2 text-xs font-medium text-neutral-300 line-clamp-2">{alt}</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setHasError(true)}
      className={className}
    />
  );
};

interface QRCodeMatrixProps {
  value: string;
  size?: number;
  className?: string;
}

/**
 * Deterministic crisp SVG QR Code visual representation for tickets and Pix payload preview.
 */
export const QRCodeVisual: React.FC<QRCodeMatrixProps> = ({
  value,
  size = 148,
  className = '',
}) => {
  const gridSize = 21;
  // Deterministic hash from value string
  let seed = 2166136261;
  for (let i = 0; i < value.length; i++) {
    seed ^= value.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }

  const isFinderPattern = (r: number, c: number) => {
    const inTopLeft = r < 7 && c < 7;
    const inTopRight = r < 7 && c >= gridSize - 7;
    const inBottomLeft = r >= gridSize - 7 && c < 7;
    return inTopLeft || inTopRight || inBottomLeft;
  };

  const getFinderModule = (r: number, c: number) => {
    const lr = r >= gridSize - 7 ? r - (gridSize - 7) : r;
    const lc = c >= gridSize - 7 ? c - (gridSize - 7) : c;
    if (lr === 0 || lr === 6 || lc === 0 || lc === 6) return true;
    if (lr >= 2 && lr <= 4 && lc >= 2 && lc <= 4) return true;
    return false;
  };

  const cells: boolean[][] = [];
  for (let r = 0; r < gridSize; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < gridSize; c++) {
      if (isFinderPattern(r, c)) {
        row.push(getFinderModule(r, c));
      } else if (r === 7 || c === 7) {
        row.push(false);
      } else if (r === 6 || c === 6) {
        row.push((r + c) % 2 === 0);
      } else {
        const bitIndex = (r * gridSize + c) % 31;
        const hashVal = Math.abs((seed >> (bitIndex % 16)) ^ (r * 37 + c * 101));
        row.push(hashVal % 2 === 0);
      }
    }
    cells.push(row);
  }

  return (
    <div
      className={`inline-flex items-center justify-center bg-white p-2.5 rounded-lg shadow-inner ${className}`}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${gridSize} ${gridSize}`}
        shapeRendering="crispEdges"
        aria-label={`QR Code para ${value}`}
        role="img"
      >
        <rect width={gridSize} height={gridSize} fill="#ffffff" />
        {cells.map((row, rIdx) =>
          row.map((active, cIdx) =>
            active ? (
              <rect key={`${rIdx}-${cIdx}`} x={cIdx} y={rIdx} width={1} height={1} fill="#070709" />
            ) : null
          )
        )}
      </svg>
    </div>
  );
};
