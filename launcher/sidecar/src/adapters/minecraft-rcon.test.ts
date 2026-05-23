import { describe, expect, it } from 'vitest';

import { isIdleResponse, parsePlayerCount } from './minecraft-rcon.js';

// minecraft の `list` レスポンスをどう解釈するかが adapter の責務。RCON 通信自体は
// rcon-client に委ねるので、ここではパース部分だけを純粋関数としてテストする。

describe('parsePlayerCount', () => {
  it('parses 0 players from the typical response', () => {
    expect(parsePlayerCount('There are 0 of a max of 20 players online: ')).toBe(0);
  });

  it('parses N players', () => {
    expect(
      parsePlayerCount('There are 3 of a max of 20 players online: Alice, Bob, Carol'),
    ).toBe(3);
  });

  it('returns -1 when no count token is present', () => {
    expect(parsePlayerCount('Server is starting up')).toBe(-1);
    expect(parsePlayerCount('')).toBe(-1);
  });
});

describe('isIdleResponse', () => {
  it('matches the default empty_pattern in atm11 registry', () => {
    const pattern = 'There are 0 of a max';
    expect(isIdleResponse('There are 0 of a max of 20 players online: ', pattern)).toBe(true);
    expect(
      isIdleResponse('There are 1 of a max of 20 players online: Alice', pattern),
    ).toBe(false);
  });
});
