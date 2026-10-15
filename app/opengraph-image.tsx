import { ImageResponse } from 'next/og'

// Generated at build time. Uses ImageResponse's default font: no font file is committed.
export const alt = 'Headjack: the three-bar mark and name with "A private home for your skills." on warm paper.'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

const PAPER = '#F6F2EA'
const INK_TITLE = '#152150'
const INK_MUTED = '#6B6457'
const COBALT = '#1E4FD8'

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: PAPER,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <svg width="160" height="160" viewBox="0 0 64 64">
            <path fill={INK_TITLE} d="M8 12h12v40H8z" />
            <path fill={COBALT} d="M28.84 11.37l11.88 1.66-5.56 39.6-11.88-1.66z" />
            <path fill={INK_TITLE} d="M44 12h12v40H44z" />
          </svg>
          <div style={{ marginLeft: 40, fontSize: 144, fontWeight: 800, letterSpacing: -4, color: INK_TITLE }}>
            Headjack
          </div>
        </div>
        <div style={{ marginTop: 40, fontSize: 44, color: INK_MUTED }}>A private home for your skills.</div>
      </div>
    ),
    { ...size },
  )
}
