import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  const hello = vscode.commands.registerCommand("envs.helloWorld", () => {
    vscode.window.showInformationMessage("Hello from envs!");
  });

  context.subscriptions.push(hello);
}

export function deactivate() {}
