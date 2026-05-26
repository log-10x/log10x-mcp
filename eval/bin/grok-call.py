#!/usr/bin/env python3
"""Generic Grok 4.3 caller for the eval harness.

Reads either a prompt file path (argv[1]) or stdin, posts to xAI's
OpenAI-compatible chat completions API, prints the response text to
stdout. Errors to stderr; exit 1 on failure.

Auth: XAI_API_KEY env var. Per the autonomous-overnight memory, the
key is in ~/.zshrc; the eval scripts invoke this via
`zsh -c 'source ~/.zshrc; python3 eval/bin/grok-call.py ...'`.

Model: grok-4.3. reasoning_effort=high. Configurable via env vars
GROK_MODEL and GROK_REASONING_EFFORT.
"""
import os, sys, json, urllib.request

def main():
    key = os.environ.get('XAI_API_KEY')
    if not key:
        print('ERROR: XAI_API_KEY not set', file=sys.stderr)
        sys.exit(1)

    if len(sys.argv) > 1 and os.path.exists(sys.argv[1]):
        with open(sys.argv[1]) as f:
            prompt = f.read()
    else:
        prompt = sys.stdin.read()

    if not prompt.strip():
        print('ERROR: empty prompt', file=sys.stderr)
        sys.exit(1)

    body = {
        'model': os.environ.get('GROK_MODEL', 'grok-4.3'),
        'reasoning_effort': os.environ.get('GROK_REASONING_EFFORT', 'high'),
        'messages': [
            {
                'role': 'system',
                'content': 'You are an experienced SRE evaluating log-analysis tool output. Be precise. Cite specific fields from the JSON when grading. Do not hedge.',
            },
            {'role': 'user', 'content': prompt},
        ],
    }

    req = urllib.request.Request(
        'https://api.x.ai/v1/chat/completions',
        data=json.dumps(body).encode('utf-8'),
        headers={
            'Authorization': f'Bearer {key}',
            'Content-Type': 'application/json',
        },
    )
    try:
        resp = urllib.request.urlopen(req, timeout=180)
        out = json.loads(resp.read())
        msg = out['choices'][0]['message']['content']
        print(msg)
    except urllib.error.HTTPError as e:
        body_text = e.read().decode('utf-8', errors='replace')
        print(f'HTTP {e.code}: {body_text}', file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f'ERR: {type(e).__name__}: {e}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
