import {Filename, ppath, PortablePath, xfs} from '@yarnpkg/fslib';
import {tests, yarn}                        from 'pkg-tests-core';

const {RequestType, withPackageServer} = tests;

describe(`Features`, () => {
  describe(`Node.js Versioning`, () => {
    test(
      `it should make the managed Node.js available through yarn node`,
      makeTemporaryEnv({
        dependencies: {
          [`@yarnpkg/node`]: `builtin:^22.0.0`,
        },
      }, async ({path, run, source}) => {
        await run(`install`, {
          env: {
            YARN_CPU_OVERRIDE: `x64`,
            YARN_OS_OVERRIDE: `linux`,
          },
        });

        const {stdout} = await run(`node`, `--version`);
        expect(stdout.trim()).toMatch(/^node-v22.0.0-linux-x64$/);
      }),
    );

    test(
      `it should make the managed Node.js available through yarn exec`,
      makeTemporaryEnv({
        dependencies: {
          [`@yarnpkg/node`]: `builtin:^22.0.0`,
        },
      }, async ({path, run, source}) => {
        await run(`install`, {
          env: {
            YARN_CPU_OVERRIDE: `x64`,
            YARN_OS_OVERRIDE: `linux`,
          },
        });

        const {stdout} = await run(`exec`, `node`, `--version`);
        expect(stdout.trim()).toMatch(/^node-v22.0.0-linux-x64$/);
      }),
    );

    test(
      `it should run scripts with the managed Node.js version`,
      makeTemporaryEnv({
        dependencies: {
          [`@yarnpkg/node`]: `builtin:^22.0.0`,
        },
        scripts: {
          [`check-version`]: `node --version`,
        },
      }, async ({path, run, source}) => {
        await run(`install`, {
          env: {
            YARN_CPU_OVERRIDE: `x64`,
            YARN_OS_OVERRIDE: `linux`,
          },
        });

        const {stdout} = await run(`check-version`);
        expect(stdout.trim()).toMatch(/^node-v22.0.0-linux-x64$/);
      }),
    );

    describe(`Distribution authentication`, () => {
      test(
        `it should send the configured authorization header`,
        makeTemporaryEnv({
          dependencies: {
            [`@yarnpkg/node`]: `builtin:^22.0.0`,
          },
        }, async ({path, run}) => {
          const authHeader = `Bearer node-dist-token`;
          const requestTypes = new Set<string>();
          await withPackageServer({
            checkAuth: (request, parsedRequest) => {
              requestTypes.add(parsedRequest.type);
              return request.headers.authorization === authHeader;
            },
          }, async serverUrl => {
            const nodeDistUrl = `${serverUrl}/node/dist`;

            await yarn.writeConfiguration(path, {
              nodeDistAuth: {
                [nodeDistUrl]: {
                  authorization: authHeader,
                },
              },
            });

            await run(`install`, {
              nodeDistUrl: `${nodeDistUrl}/`,
              env: {
                YARN_CPU_OVERRIDE: `x64`,
                YARN_OS_OVERRIDE: `linux`,
              },
            });

            expect(requestTypes).toEqual(new Set([
              RequestType.NodeDistIndex,
              RequestType.NodeDistTarball,
            ]));
          });
        }),
      );

      for (const {failedRequestType, expectedRequestTypes, errorPattern} of [
        {
          failedRequestType: RequestType.NodeDistIndex,
          expectedRequestTypes: [RequestType.NodeDistIndex],
          errorPattern: /Network error: HTTP status client error \(401 Unauthorized\) for url .*\/node\/dist\/index\.json/,
        },
        {
          failedRequestType: RequestType.NodeDistTarball,
          expectedRequestTypes: [RequestType.NodeDistIndex, RequestType.NodeDistTarball],
          errorPattern: /Network error: HTTP status client error \(401 Unauthorized\) for url .*\/node\/dist\/v22\.0\.0\/node-v22\.0\.0-linux-x64\.tar\.gz/,
        },
      ]) {
        test(
          `it should fail with a descriptive error when the server returns a 401 for ${failedRequestType}`,
          makeTemporaryEnv({
            dependencies: {
              [`@yarnpkg/node`]: `builtin:^22.0.0`,
            },
          }, async ({path, run}) => {
            const validAuthHeader = `Bearer valid-node-dist-token`;
            const authHeader = `Bearer invalid-node-dist-token`;
            const receivedAuthHeaders = new Map<string, string | undefined>();
            await withPackageServer({
              checkAuth: (request, parsedRequest) => {
                receivedAuthHeaders.set(parsedRequest.type, request.headers.authorization);
                return parsedRequest.type !== failedRequestType
                  || request.headers.authorization === validAuthHeader;
              },
            }, async serverUrl => {
              const nodeDistUrl = `${serverUrl}/node/dist`;

              await yarn.writeConfiguration(path, {
                nodeDistAuth: {
                  [nodeDistUrl]: {
                    authorization: authHeader,
                  },
                },
              });

              await expect(run(`install`, {
                nodeDistUrl,
                env: {
                  YARN_CPU_OVERRIDE: `x64`,
                  YARN_OS_OVERRIDE: `linux`,
                },
              })).rejects.toThrow(errorPattern);

              expect(receivedAuthHeaders).toEqual(new Map(
                expectedRequestTypes.map(requestType => [requestType, authHeader] as const),
              ));
            });
          }),
        );
      }

      test(
        `it should not send authorization configured for another distribution URL`,
        makeTemporaryEnv({
          dependencies: {
            [`@yarnpkg/node`]: `builtin:^22.0.0`,
          },
        }, async ({path, run}) => {
          const requestTypes = new Set<string>();
          await withPackageServer({
            checkAuth: (request, parsedRequest) => {
              requestTypes.add(parsedRequest.type);
              return request.headers.authorization === undefined;
            },
          }, async serverUrl => {
            await yarn.writeConfiguration(path, {
              nodeDistAuth: {
                [`${serverUrl}/another/dist`]: {
                  authorization: `Bearer must-not-leak`,
                },
                [`${serverUrl}/node/dist//`]: {
                  authorization: `Bearer must-not-leak-on-a-different-path`,
                },
                [`https://trusted.example.com/node/dist`]: {
                  authorization: `Bearer must-not-leak-either`,
                },
              },
            });

            await run(`install`, {
              nodeDistUrl: `${serverUrl}/node/dist`,
              env: {
                YARN_CPU_OVERRIDE: `x64`,
                YARN_OS_OVERRIDE: `linux`,
              },
            });

            expect(requestTypes).toEqual(new Set([
              RequestType.NodeDistIndex,
              RequestType.NodeDistTarball,
            ]));
          });
        }),
      );

      test(
        `it should not follow authenticated redirects outside the distribution base URL`,
        makeTemporaryEnv({
          dependencies: {
            [`@yarnpkg/node`]: `builtin:^22.0.0`,
          },
        }, async ({path, run}) => {
          const authHeader = `Bearer node-dist-token`;
          const requestTypes = new Set<string>();
          let serverUrl: string;

          await withPackageServer({
            checkAuth: (request, parsedRequest, response) => {
              requestTypes.add(parsedRequest.type);

              if (parsedRequest.type === RequestType.NodeDistIndex) {
                response.writeHead(302, {location: `${serverUrl}/no-deps`});
                response.end();
                return false;
              }

              return request.headers.authorization === undefined;
            },
          }, async value => {
            serverUrl = value;
            const nodeDistUrl = `${serverUrl}/node/dist`;

            await yarn.writeConfiguration(path, {
              nodeDistAuth: {
                [nodeDistUrl]: {
                  authorization: authHeader,
                },
              },
            });

            await expect(run(`install`, {
              nodeDistUrl,
              httpRetry: 0,
              env: {
                YARN_CPU_OVERRIDE: `x64`,
                YARN_OS_OVERRIDE: `linux`,
              },
            })).rejects.toThrow(/error following redirect/);

            expect(requestTypes).toEqual(new Set([
              RequestType.NodeDistIndex,
            ]));
          });
        }),
      );

      test(
        `it should reject ambiguous normalized authentication URLs`,
        makeTemporaryEnv({
          dependencies: {
            [`@yarnpkg/node`]: `builtin:^22.0.0`,
          },
        }, async ({path, run}) => {
          const nodeDistUrl = `https://trusted.example.com/node/dist`;

          await yarn.writeConfiguration(path, {
            nodeDistAuth: {
              [nodeDistUrl]: {
                authorization: `Bearer first-token`,
              },
              [`${nodeDistUrl}/`]: {
                authorization: `Bearer second-token`,
              },
            },
          });

          await expect(run(`install`, {
            nodeDistUrl,
          })).rejects.toThrow(/Invalid config value for nodeDistAuth \(contains multiple entries for the configured nodeDistUrl\)/);
        }),
      );

      test(
        `it should not downgrade an authenticated HTTPS distribution URL`,
        makeTemporaryEnv({
          dependencies: {
            [`@yarnpkg/node`]: `builtin:^22.0.0`,
          },
        }, async ({path, run}) => {
          const nodeDistUrl = `https://trusted.example.com/node/dist`;

          await yarn.writeConfiguration(path, {
            nodeDistAuth: {
              [nodeDistUrl]: {
                authorization: `Bearer node-dist-token`,
              },
            },
          });

          await expect(run(`install`, {
            nodeDistUrl,
            enforceUnsafeHttp: true,
          })).rejects.toThrow(/Invalid config value for nodeDistAuth \(cannot authenticate an HTTPS distribution URL when enforceUnsafeHttp is enabled\)/);
        }),
      );
    });

    describe(`Monorepo support`, () => {
      test(
        `it should allow declaring @yarnpkg/node in a workspace profile`,
        makeTemporaryMonorepoEnv(
          {
            workspaces: [`packages/*`],
          },
          {
            [`packages/workspace-a`]: {
              name: `workspace-a`,
              version: `1.0.0`,
            },
          },
          async ({path, run, source}) => {
            await yarn.writeConfiguration(path, {
              workspaceProfiles: {
                default: {
                  devDependencies: {
                    [`@yarnpkg/node`]: `builtin:^22.0.0`,
                  },
                },
              },
            });

            await run(`install`, {
              env: {
                YARN_CPU_OVERRIDE: `x64`,
                YARN_OS_OVERRIDE: `linux`,
              },
            });

            // Should be able to use the managed Node.js from the workspace
            const {stdout} = await run(`node`, `--version`, {cwd: `${path}/packages/workspace-a` as PortablePath});
            expect(stdout.trim()).toMatch(/^node-v22.0.0-linux-x64$/);
          },
        ),
      );
    });

    describe(`Different versions`, () => {
      test(
        `it should support Node.js 20.x`,
        makeTemporaryEnv({
          dependencies: {
            [`@yarnpkg/node`]: `builtin:^20.0.0`,
          },
        }, async ({path, run, source}) => {
          await run(`install`, {
            env: {
              YARN_CPU_OVERRIDE: `x64`,
              YARN_OS_OVERRIDE: `linux`,
            },
          });

          const {stdout} = await run(`node`, `--version`);
          expect(stdout.trim()).toMatch(/^node-v20.0.0-linux-x64$/);
        }),
      );

      test(
        `it should support Node.js 22.x`,
        makeTemporaryEnv({
          dependencies: {
            [`@yarnpkg/node`]: `builtin:^22.0.0`,
          },
        }, async ({path, run, source}) => {
          await run(`install`, {
            env: {
              YARN_CPU_OVERRIDE: `x64`,
              YARN_OS_OVERRIDE: `linux`,
            },
          });

          const {stdout} = await run(`node`, `--version`);
          expect(stdout.trim()).toMatch(/^node-v22.0.0-linux-x64$/);
        }),
      );
    });

    describe(`Platform support`, () => {
      test(
        `it should by default only fetch the @yarnpkg/node package for the current platform`,
        makeTemporaryEnv({
          dependencies: {
            [`@yarnpkg/node`]: `builtin:^22.0.0`,
          },
        }, async ({path, run, source}) => {
          await run(`install`, {
            env: {
              YARN_CPU_OVERRIDE: `x64`,
              YARN_OS_OVERRIDE: `linux`,
            },
          });

          const allCachedFiles = await xfs.readdirPromise(ppath.join(path, `.yarn/cache`));
          const nodeFiles = allCachedFiles.sort().filter(file => file.startsWith(`@yarnpkg-node-`));

          expect(nodeFiles).toEqual([
            expect.stringMatching(/@yarnpkg-node-linux-x64-builtin-22\.0\.0-/),
          ]);
        }),
      );

      test(
        `it should fetch @yarnpkg/node packages for multiple platforms when supportedArchitectures is configured`,
        makeTemporaryEnv({
          dependencies: {
            [`@yarnpkg/node`]: `builtin:^22.0.0`,
          },
        }, async ({path, run, source}) => {
          await xfs.writeJsonPromise(ppath.join(path, Filename.rc), {
            supportedArchitectures: {
              os: [`linux`, `darwin`],
              cpu: [`x64`],
            },
          });

          await run(`install`, {
            env: {
              YARN_CPU_OVERRIDE: `x64`,
              YARN_OS_OVERRIDE: `linux`,
            },
          });

          const allCachedFiles = await xfs.readdirPromise(ppath.join(path, `.yarn/cache`));
          const nodeFiles = allCachedFiles.sort().filter(file => file.startsWith(`@yarnpkg-node-`));

          expect(nodeFiles).toEqual([
            expect.stringMatching(/@yarnpkg-node-darwin-x64-builtin-22\.0\.0-/),
            expect.stringMatching(/@yarnpkg-node-linux-x64-builtin-22\.0\.0-/),
          ]);
        }),
      );

      test(
        `it should produce a stable lockfile regardless of the current platform`,
        makeTemporaryEnv({
          dependencies: {
            [`@yarnpkg/node`]: `builtin:^22.0.0`,
          },
        }, async ({path, run, source}) => {
          await xfs.writeJsonPromise(ppath.join(path, Filename.rc), {
            supportedArchitectures: {
              os: [`linux`, `darwin`],
              cpu: [`x64`],
            },
          });

          await run(`install`, {
            env: {
              YARN_CPU_OVERRIDE: `x64`,
              YARN_OS_OVERRIDE: `linux`,
            },
          });

          const lockfileLinux = await xfs.readFilePromise(ppath.join(path, Filename.lockfile), `utf8`);

          await run(`install`, {
            env: {
              YARN_CPU_OVERRIDE: `x64`,
              YARN_OS_OVERRIDE: `darwin`,
            },
          });

          const lockfileDarwin = await xfs.readFilePromise(ppath.join(path, Filename.lockfile), `utf8`);

          expect(lockfileDarwin).toEqual(lockfileLinux);
        }),
      );

      test(
        `it should resolve platform-specific packages for arm64 and x64 when both are configured`,
        makeTemporaryEnv({
          dependencies: {
            [`@yarnpkg/node`]: `builtin:^22.0.0`,
          },
        }, async ({path, run, source}) => {
          await xfs.writeJsonPromise(ppath.join(path, Filename.rc), {
            supportedArchitectures: {
              os: [`linux`],
              cpu: [`x64`, `arm64`],
            },
          });

          await run(`install`, {
            env: {
              YARN_CPU_OVERRIDE: `x64`,
              YARN_OS_OVERRIDE: `linux`,
            },
          });

          const allCachedFiles = await xfs.readdirPromise(ppath.join(path, `.yarn/cache`));
          const nodeFiles = allCachedFiles.sort().filter(file => file.startsWith(`@yarnpkg-node-`));

          expect(nodeFiles).toEqual([
            expect.stringMatching(/@yarnpkg-node-linux-arm64-builtin-22\.0\.0-/),
            expect.stringMatching(/@yarnpkg-node-linux-x64-builtin-22\.0\.0-/),
          ]);
        }),
      );
    });
  });
});
