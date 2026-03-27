import { useState } from 'react';
import { Box, Newline, Text, useApp, useInput } from 'ink';

export type TrustDecision = 'trust' | 'exit';

type TrustPromptProps = {
  currentPath: string;
  onDecision?: (decision: TrustDecision) => void;
};

const OPTIONS: Array<{ label: string; value: TrustDecision; tone: 'green' | 'yellow' }> = [
  { label: 'Yes, trust this folder', value: 'trust', tone: 'green' },
  { label: 'No, exit', value: 'exit', tone: 'yellow' },
];

export function TrustPrompt({ currentPath, onDecision }: TrustPromptProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { exit } = useApp();

  const commit = (decision: TrustDecision) => {
    onDecision?.(decision);
    exit();
  };

  useInput((input, key) => {
    if (key.upArrow || key.leftArrow) {
      setSelectedIndex((current) => (current - 1 + OPTIONS.length) % OPTIONS.length);
      return;
    }

    if (key.downArrow || key.rightArrow || key.tab) {
      setSelectedIndex((current) => (current + 1) % OPTIONS.length);
      return;
    }

    if (key.return) {
      commit(OPTIONS[selectedIndex]?.value ?? 'exit');
      return;
    }

    if (key.escape || (key.ctrl && input === 'c')) {
      commit('exit');
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="yellow"
        paddingX={1}
        paddingY={0}
        marginBottom={1}
      >
        <Text bold color="yellow">
          Workspace Trust Check
        </Text>
        <Newline />
        <Text color="white">{currentPath}</Text>
        <Newline />
        <Text color="gray">
          Odradek will be able to read, edit, and execute files in this workspace.
        </Text>
        <Text color="gray">
          Trust this folder only if it belongs to you or comes from a source you trust.
        </Text>
      </Box>

      {OPTIONS.map((option, index) => {
        const selected = index === selectedIndex;
        const prefix = selected ? '›' : ' ';
        const color = selected ? option.tone : 'gray';
        return (
          <Text key={option.value} color={color}>
            {prefix} {option.label}
          </Text>
        );
      })}

      <Newline />
      <Text color="gray">Use ↑/↓ or Tab to switch, then press Enter.</Text>
    </Box>
  );
}
