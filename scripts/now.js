#! /usr/bin/env node
/* eslint-disable camelcase */
const github = require('octonode');
const normalizeUrl = require('normalize-url');
const spawn = require('cross-spawn');
const travisAfterAll = require('travis-after-all');
const urlRegex = require('url-regex');
const argv = require('yargs').argv;
const axios = require('axios');

const nowCli = require.resolve('now/download/dist/now');

if (!process.env.CI || !process.env.TRAVIS) {
  throw new Error('Could not detect Travis CI environment');
}

const githubToken = process.env.GH_TOKEN;
const nowToken = process.env.NOW_TOKEN;
const discordHook = process.env.DISCORD_HOOK;

if (!githubToken) {
  throw new Error('Missing required environment variable GH_TOKEN');
}

if (!nowToken) {
  throw new Error('Missing required environment variable NOW_TOKEN');
}

console.log(process.env.TRAVIS_PULL_REQUEST);

const client = github.client(githubToken);
const ghRepo = client.repo(process.env.TRAVIS_REPO_SLUG);
let ghPR;

if (process.env.TRAVIS_PULL_REQUEST) {
  ghPR = client.issue(
    process.env.TRAVIS_REPO_SLUG,
    process.env.TRAVIS_PULL_REQUEST,
  );
}

function noop() {}

function getUrl(content) {
  const urls = content.match(urlRegex()) || [];

  return urls.map(url => normalizeUrl(url.trim().replace(/\.+$/, '')))[0];
}

function deploy(context, sha) {
  ghRepo.status(
    sha,
    {
      context,
      state: 'pending',
      description: `Δ Now ${context} deployment pending`,
    },
    noop,
  );

  const args = [
    '--token',
    nowToken,
    '--team',
    'coderplex',
    '--no-clipboard',
    '-n',
    'coderplex-app',
  ];
  const alias = context === 'production' && process.env.NOW_ALIAS;
  let stdout = '';

  if (argv.p || argv.public) {
    args.push(...['-p']);
  }

  if (argv.folder) {
    args.push(argv.folder);
  }

  const child = spawn(nowCli, args);

  if (!alias) {
    child.stdout.on('data', data => {
      stdout += data;
    });
  }

  child.on('error', err => {
    console.error(err);
    ghRepo.status(
      sha,
      {
        context,
        state: 'error',
        description: `Δ Now ${context} deployment failed. See Travis logs for details.`,
      },
      noop,
    );
    axios
      .post(discordHook, {
        content: `Δ Now ${context} deployment failed. See Travis logs for details.`,
        username: 'coderplex-bot',
      })
      .then(() => {
        console.log(`SUCCESS posted to discord`);
      })
      .catch(console.log);
  });

  child.on('close', () => {
    const target_url = getUrl(stdout);
    const comment = url =>
      `### New Δ Now ${context} deployment complete\n- ✅ **Build Passed**\n- 🚀 **URL** : ${url}\n---\nNote: **This is autogenerated through travis-ci build**`;
    if (alias) {
      const args = [
        'alias',
        '--token',
        nowToken,
        '--team',
        'coderplex',
        'set',
        target_url,
        alias,
      ];
      spawn(nowCli, args);
      axios
        .post(discordHook, {
          content: comment(`${alias} and https://coderplex.org`),
          username: 'coderplex-bot',
        })
        .then(() => {
          console.log(`SUCCESS posted to discord`);
        })
        .catch(console.log);
    }
    if (ghPR) {
      console.log(comment(target_url));
      ghPR.createComment(
        {
          body: comment(target_url),
        },
        (err, res) => {
          console.log(err, res);
        },
      );
    } else {
      console.log('No PR found');
    }
    ghRepo.status(
      sha,
      {
        context,
        target_url,
        state: 'success',
        description: `Δ Now ${context} deployment complete`,
      },
      noop,
    );
  });
}

travisAfterAll((code, err) => {
  // Don't do anything if there was an error of if the build returned a failing code
  if (err || code) {
    return;
  }

  switch (process.env.TRAVIS_EVENT_TYPE) {
    case 'pull_request':
      return deploy('staging', process.env.TRAVIS_PULL_REQUEST_SHA);
    case 'push':
      return deploy('production', process.env.TRAVIS_COMMIT);
    default:
      return '';
  }
});
