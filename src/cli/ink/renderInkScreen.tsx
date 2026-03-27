import { ReactNode, useEffect } from 'react';
import { render, useApp } from 'ink';

function StaticExit({ children }: { children: ReactNode }) {
  const { exit } = useApp();

  useEffect(() => {
    const timer = setTimeout(() => exit(), 0);
    return () => clearTimeout(timer);
  }, [exit]);

  return <>{children}</>;
}

export async function renderStaticInkScreen(children: ReactNode): Promise<void> {
  const instance = render(<StaticExit>{children}</StaticExit>, {
    exitOnCtrlC: false,
    patchConsole: false,
  });

  await instance.waitUntilExit();
}
