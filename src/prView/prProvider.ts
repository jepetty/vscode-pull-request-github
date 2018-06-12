/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as vscode from 'vscode';
import { Configuration } from '../configuration';
import { PRType } from '../models/pullRequestModel';
import { Repository } from '../models/repository';
import { TreeNode } from '../tree/TreeNode';
import { PRGroupActionNode, PRGroupTreeNode, PRGroupActionType } from '../tree/prGroupNode';

export class PRProvider implements vscode.TreeDataProvider<TreeNode>, vscode.TextDocumentContentProvider, vscode.DecorationProvider {
	private static _instance: PRProvider;
	private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	get onDidChange(): vscode.Event<vscode.Uri> { return this._onDidChange.event; }

	private _disposables: vscode.Disposable[];

	private constructor(
		private configuration: Configuration,
		private repository: Repository
	) {
		this._disposables = [];
		this._disposables.push(vscode.workspace.registerTextDocumentContentProvider('pr', this));
		this._disposables.push(vscode.window.registerDecorationProvider(this));
		this._disposables.push(vscode.commands.registerCommand('pr.refreshList', _ => {
			this._onDidChangeTreeData.fire();
		}));
		this._disposables.push(vscode.window.registerTreeDataProvider<TreeNode>('pr', this));
		this._disposables.push(this.configuration.onDidChange(e => {
			this._onDidChangeTreeData.fire();
		}));
	}

	static initialize(
		configuration: Configuration,
		repository: Repository) {
		if (PRProvider._instance) {
			PRProvider._instance.dispose();
		}
		PRProvider._instance = new PRProvider(configuration, repository);
	}

	static get instance() {
		return PRProvider._instance;
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		return element.getTreeItem();
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		if (!element) {
			return Promise.resolve([
				new PRGroupTreeNode(this.repository, PRType.LocalPullRequest),
				new PRGroupTreeNode(this.repository, PRType.RequestReview),
				new PRGroupTreeNode(this.repository, PRType.ReviewedByMe),
				new PRGroupTreeNode(this.repository, PRType.Mine),
				new PRGroupTreeNode(this.repository, PRType.All)
			]);
		}
		if (!this.repository.remotes || !this.repository.remotes.length) {
			return Promise.resolve([new PRGroupActionNode(PRGroupActionType.Empty)]);
		}

		return element.getChildren();
	}

	_onDidChangeDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
	onDidChangeDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeDecorations.event;
	provideDecoration(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<vscode.DecorationData> {
		if (uri.scheme === 'pr') {
			return {
				bubble: true,
				abbreviation: '♪♪',
				title: '♪♪'
			};
		} else {
			return {};
		}
	}

	async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
		let { path } = JSON.parse(uri.query);
		try {
			let content = fs.readFileSync(vscode.Uri.file(path).fsPath);
			return content.toString();
		} catch (e) {
			return '';
		}
	}

	dispose() {
		this._disposables.forEach(dispose => {
			dispose.dispose();
		});
	}
}
