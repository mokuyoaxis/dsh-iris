/** The factory registered with DSH's browser ModuleLoader, not a Node module export. */
export interface DshClientPlugin {
  inject: string[];
  apply(ctx: any): void;
}
