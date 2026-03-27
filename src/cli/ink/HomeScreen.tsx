import { Box, Newline, Text } from 'ink';

export type HomeScreenTone = 'success' | 'warning' | 'danger' | 'info' | 'muted';

export type HomeScreenLine = {
  label?: string;
  value: string;
  tone?: HomeScreenTone;
};

export type HomeScreenCard = {
  title: string;
  status: string;
  statusTone: HomeScreenTone;
  lines: HomeScreenLine[];
};

type HomeScreenProps = {
  version: string;
  cards: HomeScreenCard[];
};

function toneToColor(tone: HomeScreenTone): string {
  switch (tone) {
    case 'success':
      return 'green';
    case 'warning':
      return 'yellow';
    case 'danger':
      return 'red';
    case 'info':
      return 'cyan';
    default:
      return 'gray';
  }
}

function HomeCard({ card }: { card: HomeScreenCard }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      paddingY={0}
      marginBottom={1}
    >
      <Text bold>{card.title}</Text>
      <Text color={toneToColor(card.statusTone)}>{card.status}</Text>
      <Newline />
      {card.lines.map((line, index) => (
        <Text key={`${card.title}-${index}`} color={toneToColor(line.tone ?? 'muted')}>
          {line.label ? `${line.label}: ${line.value}` : line.value}
        </Text>
      ))}
    </Box>
  );
}

export function HomeScreen({ version, cards }: HomeScreenProps) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="white">
        Odradek
      </Text>
      <Text color="gray">Internal Build: {version}</Text>
      <Newline />
      {cards.map((card) => (
        <HomeCard key={card.title} card={card} />
      ))}
      <Text color="gray">Type a message to start chatting.</Text>
      <Text color="gray">Type / for commands and press Tab to autocomplete.</Text>
    </Box>
  );
}
