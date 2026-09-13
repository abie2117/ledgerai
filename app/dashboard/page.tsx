'use client';

import { useEffect } from 'react';

export default function DashboardPage() {
  useEffect(() => {
    console.log('🔥🔥🔥 CORRECT DASHBOARD FILE IS LOADED 🔥🔥🔥');
  }, []);

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#070b14',
        color: '#38bdf8',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'Arial, sans-serif',
        fontSize: '32px',
        fontWeight: 700,
      }}
    >
      CORRECT LEDGERAI DASHBOARD
    </div>
  );
}
