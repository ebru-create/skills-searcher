import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFindOptions, runFind, runSearchPrompt, searchSkillsAPI } from './find.ts';

vi.mock('readline', () => ({ emitKeypressEvents: vi.fn() }));

const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('parseFindOptions', () => {
  it('separates and normalizes an owner from a multi-word query', () => {
    expect(parseFindOptions(['react', 'native', '--owner', 'Vercel'])).toEqual({
      query: 'react native',
      options: { owner: 'vercel' },
      errors: [],
    });
  });

  it('supports the --owner=value form', () => {
    expect(parseFindOptions(['--owner=vercel-labs', 'next'])).toEqual({
      query: 'next',
      options: { owner: 'vercel-labs' },
      errors: [],
    });
  });

  it('rejects missing and invalid owners', () => {
    expect(parseFindOptions(['react', '--owner']).errors).toEqual([
      '--owner requires a GitHub owner',
    ]);
    expect(parseFindOptions(['react', '--owner', 'not/an/owner']).errors).toEqual([
      '--owner must be a valid GitHub owner',
    ]);
  });
});

describe('searchSkillsAPI', () => {
  it('sends the owner as an API query parameter', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ skills: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await searchSkillsAPI('react native', 'vercel');

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/api/search');
    expect(url.searchParams.get('q')).toBe('react native');
    expect(url.searchParams.get('owner')).toBe('vercel');
    expect(url.searchParams.get('limit')).toBe('20');
  });

  it('prints every result returned for a non-interactive query', async () => {
    const skills = Array.from({ length: 11 }, (_, index) => ({
      id: `owner/repo/skill-${index + 1}`,
      name: `skill-${index + 1}`,
      installs: 11 - index,
      source: 'owner/repo',
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ skills }),
      })
    );
    vi.stubEnv('DISABLE_TELEMETRY', '1');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runFind(['owner/repo']);

    const output = log.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(output).toContain('owner/repo@skill-1');
    expect(output).toContain('owner/repo@skill-11');
  });
});

function skill(index: number) {
  return {
    id: `owner/repo/skill-${index}`,
    name: `skill-${index}`,
    source: 'owner/repo',
    installs: 100 - index,
  };
}

function response(skills: unknown[]) {
  return { ok: true, json: async () => ({ skills }) };
}

describe('search failure handling', () => {
  it('distinguishes HTTP failures from successful empty results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce(response([]))
    );
    await expect(searchSkillsAPI('react')).rejects.toThrow('HTTP 503');
    await expect(searchSkillsAPI('react')).resolves.toEqual([]);
  });

  it('reports network failures without leaking raw error details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('sensitive internal detail')));
    await expect(searchSkillsAPI('react')).rejects.toThrow('Could not reach the search service');
  });

  it('reports malformed JSON as an invalid response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError('Invalid JSON');
        },
      })
    );
    await expect(searchSkillsAPI('react')).rejects.toThrow('invalid response');
  });

  it.each([0, -1, NaN, Infinity, '100', undefined])(
    'normalizes an invalid or empty install count %s and a non-string source',
    async (installs) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(response([{ ...skill(1), source: { unexpected: true }, installs }]))
      );
      await expect(searchSkillsAPI('react')).resolves.toEqual([
        { name: 'skill-1', slug: 'owner/repo/skill-1', source: '', installs: 0 },
      ]);
    }
  );

  it('preserves valid entries when another entry is malformed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([skill(1), { name: null }, null])));
    await expect(searchSkillsAPI('react')).resolves.toEqual([
      { name: 'skill-1', slug: 'owner/repo/skill-1', source: 'owner/repo', installs: 99 },
    ]);
  });

  it.each([{}, { skills: null }, { skills: [{ name: null }] }])(
    'reports an invalid response instead of claiming no matches: %j',
    async (data) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => data }));
      await expect(searchSkillsAPI('react')).rejects.toThrow(/invalid/);
    }
  );

  it('times out requests and reports a retryable message', async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), {
              once: true,
            });
          })
      )
    );
    const pending = searchSkillsAPI('react');
    const assertion = expect(pending).rejects.toThrow('Search timed out');
    timeout.abort(new DOMException('Timed out', 'TimeoutError'));
    await assertion;
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  it('returns a nonzero exit status without a no-results message on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runFind(['react']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'));
    expect(log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe('interactive search', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
    vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
  });

  function key(name: string, sequence?: string) {
    process.stdin.emit('keypress', sequence, { name, sequence });
  }

  function output() {
    return vi
      .mocked(process.stdout.write)
      .mock.calls.map(([text]) => String(text))
      .join('');
  }

  it('keeps the ninth result visible and selects it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response(Array.from({ length: 12 }, (_, i) => skill(i + 1))))
    );
    const pending = runSearchPrompt('react');
    await vi.advanceTimersByTimeAsync(150);
    for (let i = 0; i < 8; i++) key('down');
    expect(output()).toContain('9 of 12');
    expect(output()).toContain('>\x1b[0m \x1b[1mskill-9');
    key('return');
    await expect(pending).resolves.toMatchObject({ name: 'skill-9' });
  });

  it('ignores a stale response even if the transport ignores abort', async () => {
    let finishOld!: (value: ReturnType<typeof response>) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          })
      )
      .mockResolvedValueOnce(response([skill(2)]));
    vi.stubGlobal('fetch', fetchMock);
    const pending = runSearchPrompt('react');
    await vi.advanceTimersByTimeAsync(150);
    key('x', 'x');
    expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(150);
    finishOld(response([skill(1)]));
    await vi.advanceTimersByTimeAsync(0);
    key('return');
    await expect(pending).resolves.toMatchObject({ name: 'skill-2' });
  });

  it('does not let Enter install a result from the previous query', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response([skill(1)]))
      .mockResolvedValueOnce(response([skill(2)]));
    vi.stubGlobal('fetch', fetchMock);
    const pending = runSearchPrompt('react');
    await vi.advanceTimersByTimeAsync(150);
    key('x', 'x');
    key('return');
    await vi.advanceTimersByTimeAsync(150);
    key('return');
    await expect(pending).resolves.toMatchObject({ name: 'skill-2' });
  });

  it('clears the debounce timer when cancelled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const pending = runSearchPrompt('react');
    key('escape');
    await expect(pending).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts an active request and never renders after cancellation', async () => {
    let finish!: (value: ReturnType<typeof response>) => void;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const pending = runSearchPrompt('react');
    await vi.advanceTimersByTimeAsync(150);
    key('escape');
    await expect(pending).resolves.toBeNull();
    expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true);
    const count = vi.mocked(process.stdout.write).mock.calls.length;
    finish(response([skill(1)]));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(process.stdout.write).mock.calls).toHaveLength(count);
  });

  it('shows a service error and allows a new query to recover', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValueOnce(response([skill(2)]))
    );
    const pending = runSearchPrompt('react');
    await vi.advanceTimersByTimeAsync(150);
    expect(output()).toContain('HTTP 503');
    key('return');
    key('x', 'x');
    await vi.advanceTimersByTimeAsync(150);
    key('return');
    await expect(pending).resolves.toMatchObject({ name: 'skill-2' });
  });
});
