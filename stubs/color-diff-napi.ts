export type SyntaxTheme = {
  name: string;
};

export class ColorDiff {
  constructor(..._args: unknown[]) {}
  render(..._args: unknown[]): string[] | null {
    return null;
  }
  format(input: string): string {
    return input;
  }
}

export class ColorFile {
  constructor(..._args: unknown[]) {}
  render(..._args: unknown[]): string[] | null {
    return null;
  }
  format(input: string): string {
    return input;
  }
}

export function getSyntaxTheme(themeName: string): SyntaxTheme {
  return { name: themeName };
}
