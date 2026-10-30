import { createCorePluginWorkbench, type CorePluginWorkbenchOptions } from '@mokuyoaxis/dsh-iris/plugins';

async function legacy() {
  const web = createCorePluginWorkbench({ dataRoot: '/explicit/core' });
  const started = await web.start();
  const expires: string = started.loginExpiresAt;
  // @ts-expect-error Legacy SDK callers do not opt into password state.
  void started.authentication;
  void expires;
  await web.dispose();
}

async function password() {
  const web = createCorePluginWorkbench({ dataRoot: '/explicit/core', workbenchAuth: { directory: '/explicit/private-auth' } });
  const started = await web.start();
  const mode: 'password' = started.authentication.mode;
  const rememberDays: 30 = started.authentication.rememberDays;
  const configured: boolean = started.authentication.configured;
  const address: string = started.loginUrl;
  // @ts-expect-error Password login does not have a ten-minute link expiry.
  void started.loginExpiresAt;
  void [mode, rememberDays, configured, address];
  await web.dispose();
}

async function dynamic(options: CorePluginWorkbenchOptions) {
  const started = await createCorePluginWorkbench(options).start();
  if ('authentication' in started) {
    const mode: 'password' = started.authentication.mode;
    void mode;
  } else {
    const expires: string = started.loginExpiresAt;
    void expires;
  }
}
void [legacy, password, dynamic];
