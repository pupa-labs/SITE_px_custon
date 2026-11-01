import React, { useState, useMemo } from 'react';
import { OFFICIAL_LOGO_ORIGINAL, OFFICIAL_LOGO_TRANSPARENT } from '../services/platformService';
import { generateRealQrCodeMatrix } from '../utils/ticketRules';

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

  React.useEffect(() => {
    setHasError(false);
  }, [src]);

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
 * Standards-compliant ISO/IEC 18004 SVG QR Code generator for PX CUSTON tickets and Pix payloads.
 * Uses the exact value passed (e.g. `ticket.qrPayload`) with Reed-Solomon error correction ('M'),
 * high-contrast modules (#070709 on #FFFFFF quiet zone), and subtle PX CUSTON red framing.
 */
export const QRCodeVisual: React.FC<QRCodeMatrixProps> = ({
  value,
  size = 148,
  className = '',
}) => {
  const matrix = useMemo(
    () => generateRealQrCodeMatrix(value, { errorCorrectionLevel: 'M', margin: 2 }),
    [value]
  );

  return (
    <div
      className={`inline-flex items-center justify-center bg-white p-2.5 rounded-lg border border-[#E50914]/35 shadow-[0_0_16px_rgba(229,9,20,0.16)] ${className}`}
      data-qr-payload={matrix.payload}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${matrix.totalSize} ${matrix.totalSize}`}
        shapeRendering="crispEdges"
        aria-label={`QR Code para ${value}`}
        role="img"
      >
        <rect width={matrix.totalSize} height={matrix.totalSize} fill="#ffffff" />
        {matrix.modules.map((row, rIdx) =>
          row.map((active, cIdx) =>
            active ? (
              <rect
                key={`${rIdx}-${cIdx}`}
                x={cIdx + matrix.margin}
                y={rIdx + matrix.margin}
                width={1}
                height={1}
                fill="#070709"
              />
            ) : null
          )
        )}
      </svg>
    </div>
  );
};

