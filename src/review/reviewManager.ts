/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { parseDiff } from '../common/diff';
import { getDiffLineByPosition, getLastDiffLine, mapCommentsToHead, mapHeadLineToDiffHunkPosition, mapOldPositionToNew } from '../common/diffPositionMapping';
import { PullRequestGitHelper } from '../common/pullRequestGitHelper';
import { toGitUri, fromGitUri } from '../common/uri';
import { groupBy } from '../common/util';
import { Comment } from '../models/comment';
import { GitChangeType } from '../models/file';
import { GitErrorCodes } from '../models/gitError';
import { PullRequestModel } from '../models/pullRequestModel';
import { Repository } from '../models/repository';
import { FileChangesProvider } from './fileChangesProvider';
import { GitContentProvider } from './gitContentProvider';
import { DiffChangeType } from '../models/diffHunk';
import { PRFileChangeNode } from '../tree/prFileChangeNode';
import Logger from '../logger';


export class ReviewManager implements vscode.DecorationProvider {
	private static _instance: ReviewManager;
	private _documentCommentProvider: vscode.Disposable;
	private _workspaceCommentProvider: vscode.Disposable;
	private _disposables: vscode.Disposable[];

	private _comments: Comment[] = [];
	private _localFileChanges: PRFileChangeNode[] = [];
	private _obsoleteFileChanges: PRFileChangeNode[] = [];
	private _lastCommitSha: string;
	private _updateMessageShown: boolean = false;

	private _onDidChangeCommentThreads = new vscode.EventEmitter<vscode.CommentThreadChangedEvent>();

	private _prFileChangesProvider: FileChangesProvider;
	private _statusBarItem: vscode.StatusBarItem;
	private _prNumber: number;
	private _pr: PullRequestModel;

	private constructor(
		private _repository: Repository
	) {
		this._documentCommentProvider = null;
		this._workspaceCommentProvider = null;
		this._disposables = [];
		let gitContentProvider = new GitContentProvider(_repository);
		gitContentProvider.registerTextDocumentContentFallback(this.provideTextDocumentContent.bind(this));
		this._disposables.push(vscode.workspace.registerTextDocumentContentProvider('review', gitContentProvider));
		this._disposables.push(vscode.commands.registerCommand('review.openFile', (uri: vscode.Uri) => {
			let params = JSON.parse(uri.query);
			vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.resolve(this._repository.path, params.path)), {});
		}));
		this._disposables.push(_repository.onDidRunGitStatus(e => {
			// todo, validate state only when state changes.
			this.validateState();
		}));
		this._disposables.push(vscode.window.registerDecorationProvider(this));
		this.validateState();
		this.pollForStatusChange();
	}

	static initialize(
		_repository: Repository
	) {
		if (ReviewManager._instance) {
			ReviewManager._instance.dispose();
		}
		ReviewManager._instance = new ReviewManager(_repository);
	}

	static get instance() {
		return ReviewManager._instance;
	}
	get prFileChangesProvider() {
		if (!this._prFileChangesProvider) {
			this._prFileChangesProvider = new FileChangesProvider();
			this._disposables.push(this._prFileChangesProvider);
		}

		return this._prFileChangesProvider;
	}

	get statusBarItem() {
		if (!this._statusBarItem) {
			this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
		}

		return this._statusBarItem;
	}

	get currentPullRequest(): PullRequestModel {
		return this._pr;
	}

	private pollForStatusChange() {
		setTimeout(async () => {
			await this.updateComments();
			this.pollForStatusChange();
		}, 1000 * 10);
	}

	private async validateState() {
		let branch = this._repository.HEAD;
		if (!branch) {
			this.clear(true);
			return;
		}

		let matchingPullRequestMetadata = await PullRequestGitHelper.getMatchingPullRequestMetadataForBranch(this._repository, this._repository.HEAD.name);

		if (!matchingPullRequestMetadata) {
			Logger.appendLine(`Review> no matching pull request metadata found for current branch ${this._repository.HEAD.name}`);
			this.clear(true);
			return;
		}

		if (this._prNumber === matchingPullRequestMetadata.prNumber) {
			return;
		}

		let remote = branch.upstream ? branch.upstream.remote : null;
		if (!remote) {
			Logger.appendLine(`Review> current branch ${this._repository.HEAD.name} hasn't setup remote yet`);
			this.clear(true);
			return;
		}

		// we switch to another PR, let's clean up first.
		Logger.appendLine(`Review> current branch ${this._repository.HEAD.name} is associated with pull request #${matchingPullRequestMetadata.prNumber}`);
		this.clear(false);
		this._prNumber = matchingPullRequestMetadata.prNumber;
		this._lastCommitSha = null;
		let githubRepo = this._repository.githubRepositories.find(repo =>
			repo.remote.owner.toLocaleLowerCase() === matchingPullRequestMetadata.owner.toLocaleLowerCase()
		);

		if (!githubRepo) {
			return; // todo, should show warning
		}

		const pr = await githubRepo.getPullRequest(this._prNumber);
		if (!pr) {
			Logger.appendLine('Review> This PR is no longer valid');
			return;
		}
		this._pr = pr;
		if (!this._lastCommitSha) {
			this._lastCommitSha = pr.head.sha;
		}

		await this.getPullRequestData(pr);
		await this.prFileChangesProvider.showPullRequestFileChanges(pr, this._localFileChanges);

		this._onDidChangeDecorations.fire();
		Logger.appendLine(`Review> register comments provider`);
		this.registerCommentProvider();
		
		this.statusBarItem.text = '$(git-branch) Pull Request #' + this._prNumber;
		this.statusBarItem.command = 'pr.openInGitHub';
		Logger.appendLine(`Review> display pull request status bar indicator and refresh pull request tree view.`);
		this.statusBarItem.show();
		vscode.commands.executeCommand('pr.refreshList');
	}

	private async replyToCommentThread(document: vscode.TextDocument, range: vscode.Range, thread: vscode.CommentThread, text: string) {
		try {
			let ret = await this._pr.createCommentReply(text, thread.threadId);
			thread.comments.push({
				commentId: ret.data.id,
				body: new vscode.MarkdownString(ret.data.body),
				userName: ret.data.user.login,
				gravatar: ret.data.user.avatar_url
			});
			return thread;
		} catch (e) {
			return null;
		}
	}
	private async createNewCommentThread(document: vscode.TextDocument, range: vscode.Range, text: string) {
		try {
			let uri = document.uri;
			let fileName = uri.path;
			let matchedFiles = this._localFileChanges.filter(fileChange => path.resolve(this._repository.path, fileChange.fileName) === fileName);
			if (matchedFiles && matchedFiles.length) {
				let matchedFile = matchedFiles[0];
				// git diff sha -- fileName
				let contentDiff = await this._repository.diff(matchedFile.fileName, this._lastCommitSha);
				let position = mapHeadLineToDiffHunkPosition(matchedFile.diffHunks, contentDiff, range.start.line);

				if (position < 0) {
					return;
				}

				// there is no thread Id, which means it's a new thread
				let ret = await this._pr.createComment(text, matchedFile.fileName, position);

				let comment = {
					commentId: ret.data.id,
					body: new vscode.MarkdownString(ret.data.body),
					userName: ret.data.user.login,
					gravatar: ret.data.user.avatar_url
				};

				let commentThread: vscode.CommentThread = {
					threadId: comment.commentId,
					resource: uri,
					range: range,
					comments: [comment]
				};

				return commentThread;
			}
		} catch (e) {
			return null;
		}
	}

	private async updateComments(): Promise<void> {
		const matchingPullRequestMetadata = await PullRequestGitHelper.getMatchingPullRequestMetadataForBranch(this._repository, this._repository.HEAD.name);
		if (!matchingPullRequestMetadata) { return; }

		const branch = this._repository.HEAD;
		if (!branch) { return; }

		const remote = branch.upstream ? branch.upstream.remote : null;
		if (!remote) { return; }

		const githubRepo = this._repository.githubRepositories.find(repo =>
			repo.remote.owner.toLocaleLowerCase() === matchingPullRequestMetadata.owner.toLocaleLowerCase()
		);

		if (!githubRepo) {
			return;
		}

		const pr = await githubRepo.getPullRequest(this._prNumber);
		if (!pr) {
			Logger.appendLine('Review> This PR is no longer valid');
			return;
		}

		if (pr.prItem.head.sha !== this._lastCommitSha && !this._updateMessageShown) {
			this._updateMessageShown = true;
			let result = await vscode.window.showInformationMessage('There are updates available for this branch.', {}, 'Pull');

			if (result === 'Pull') {
				await vscode.commands.executeCommand('git.pull');
				this._updateMessageShown = false;
			}
		}

		const comments = await pr.getComments();

		let added: vscode.CommentThread[] = [];
		let removed: vscode.CommentThread[] = [];
		let changed: vscode.CommentThread[] = [];

		const oldCommentThreads = this.commentsToCommentThreads(this._comments);
		const newCommentThreads = this.commentsToCommentThreads(comments);

		oldCommentThreads.forEach(thread => {
			// No current threads match old thread, it has been removed
			const matchingThreads = newCommentThreads.filter(newThread => newThread.threadId === thread.threadId);
			if (matchingThreads.length === 0) {
				removed.push(thread);
			}
		});

		function commentsEditedInThread(oldComments: vscode.Comment[], newComments: vscode.Comment[]): boolean {
			oldComments.forEach(oldComment => {
				const matchingComment = newComments.filter(newComment => newComment.commentId === oldComment.commentId);
				if (matchingComment.length !== 1) {
					return true;
				}

				if (matchingComment[0].body.value !== oldComment.body.value) {
					return true;
				}
			});

			return false;
		}

		newCommentThreads.forEach(thread => {
			const matchingCommentThread = oldCommentThreads.filter(oldComment => oldComment.threadId === thread.threadId);

			// No old threads match this thread, it is new
			if (matchingCommentThread.length === 0) {
				added.push(thread);
				if (thread.resource.scheme === 'file') {
					thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
				}
			}

			// Check if comment has been updated
			matchingCommentThread.forEach(match => {
				if (match.comments.length !== thread.comments.length || commentsEditedInThread(matchingCommentThread[0].comments, thread.comments)) {
					changed.push(thread);
				}
			});
		});

		if (added.length || removed.length || changed.length) {
			this._onDidChangeCommentThreads.fire({
				added: added,
				removed: removed,
				changed: changed
			});

			this._comments = comments;
			this._onDidChangeDecorations.fire();
		}


		return Promise.resolve(null);
	}

	private async getPullRequestData(pr: PullRequestModel): Promise<void> {
		try {
			this._comments = await pr.getComments();
			let activeComments = this._comments.filter(comment => comment.position);
			let outdatedComments = this._comments.filter(comment => !comment.position);

			const data = await pr.getFiles();
			await pr.fetchBaseCommitSha();
			let baseSha = pr.base.sha;
			let headSha = pr.head.sha;
			const richContentChanges = await parseDiff(data, this._repository, baseSha);
			this._localFileChanges = richContentChanges.map(change => {
				let changedItem = new PRFileChangeNode(
					pr,
					change.fileName,
					change.status,
					change.fileName,
					change.blobUrl,
					toGitUri(vscode.Uri.parse(change.fileName), null, null, change.status === GitChangeType.DELETE ? '' : pr.prItem.head.sha, {}),
					toGitUri(vscode.Uri.parse(change.fileName), null, null, change.status === GitChangeType.ADD ? '' : pr.prItem.base.sha, {}),
					this._repository.path,
					change.diffHunks
				);
				changedItem.sha = headSha;
				changedItem.comments = activeComments.filter(comment => comment.path === changedItem.fileName);
				return changedItem;
			});

			let commitsGroup = groupBy(outdatedComments, comment => comment.original_commit_id);
			this._obsoleteFileChanges = [];
			for (let commit in commitsGroup) {
				let commentsForCommit = commitsGroup[commit];
				let commentsForFile = groupBy(commentsForCommit, comment => comment.path);
				for (let fileName in commentsForFile) {
					let oldComments = commentsForFile[fileName];
					let obsoleteFileChange = new PRFileChangeNode(
						pr,
						fileName,
						GitChangeType.MODIFY,
						fileName,
						null,
						toGitUri(vscode.Uri.parse(path.join(`commit~${commit.substr(0, 8)}`, fileName)), fileName, null, oldComments[0].original_commit_id, {}),
						toGitUri(vscode.Uri.parse(path.join(`commit~${commit.substr(0, 8)}`, fileName)), fileName, null, oldComments[0].original_commit_id, {}),
						this._repository.path,
						[] // @todo Peng.
					);

					obsoleteFileChange.sha = commit;

					obsoleteFileChange.comments = oldComments;
					this._obsoleteFileChanges.push(obsoleteFileChange);
				}
			}

			return Promise.resolve(null);
		} catch (e) {
			Logger.appendLine(`Review> ${e}`);
		}

	}

	private outdatedCommentsToCommentThreads(fileChange: PRFileChangeNode, comments: Comment[], collapsibleState: vscode.CommentThreadCollapsibleState = vscode.CommentThreadCollapsibleState.Expanded): vscode.CommentThread[] {
		if (!comments || !comments.length) {
			return [];
		}

		let fileCommentGroups = groupBy(comments, comment => comment.path);
		let ret: vscode.CommentThread[] = [];

		for (let file in fileCommentGroups) {
			let fileComments = fileCommentGroups[file];
			let sections = groupBy(fileComments, comment => String(comment.position));

			for (let i in sections) {
				let comments = sections[i];

				const comment = comments[0];
				let diffLine = getDiffLineByPosition(comment.diff_hunks, comment.position === null ? comment.original_position : comment.position);

				if (diffLine) {
					comment.absolutePosition = diffLine.newLineNumber;
				}

				const pos = new vscode.Position(comment.absolutePosition ? comment.absolutePosition - 1 : 0, 0);
				const range = new vscode.Range(pos, pos);

				ret.push({
					threadId: comment.id,
					resource: fileChange.filePath,
					range,
					comments: comments.map(comment => {
						return {
							commentId: comment.id,
							body: new vscode.MarkdownString(comment.body),
							userName: comment.user.login,
							gravatar: comment.user.avatar_url,
							command: {
								title: 'View Changes',
								command: 'pr.viewChanges',
								arguments: [
									fileChange
								]
							}
						};
					}),
					collapsibleState: collapsibleState
				});
			}

		}
		return ret;
	}

	private commentsToCommentThreads(comments: Comment[], collapsibleState: vscode.CommentThreadCollapsibleState = vscode.CommentThreadCollapsibleState.Expanded): vscode.CommentThread[] {
		if (!comments || !comments.length) {
			return [];
		}

		let fileCommentGroups = groupBy(comments, comment => comment.path);
		let ret: vscode.CommentThread[] = [];

		for (let file in fileCommentGroups) {
			let fileComments = fileCommentGroups[file];
			let sections = groupBy(fileComments, comment => String(comment.position));

			for (let i in sections) {
				let comments = sections[i];

				const comment = comments[0];
				const pos = new vscode.Position(comment.absolutePosition ? comment.absolutePosition - 1 : 0, 0);
				const range = new vscode.Range(pos, pos);

				ret.push({
					threadId: comment.id,
					resource: vscode.Uri.file(path.resolve(this._repository.path, comment.path)),
					range,
					comments: comments.map(comment => {
						return {
							commentId: comment.id,
							body: new vscode.MarkdownString(comment.body),
							userName: comment.user.login,
							gravatar: comment.user.avatar_url
						};
					}),
					collapsibleState: collapsibleState
				});
			}

		}
		return ret;
	}

	_onDidChangeDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
	onDidChangeDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeDecorations.event;
	provideDecoration(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<vscode.DecorationData> {
		if (uri.scheme === 'review') {
			let query = JSON.parse(uri.query);
			let matchingComments = this._comments.filter(comment => comment.path === query.path);
			if (matchingComments && matchingComments.length) {
				return {
					bubble: true,
					abbreviation: '♪♪',
					title: '♪♪'
				};
			}
		} else if (uri.scheme === 'file') {
			// local file
			let fileName = uri.path;
			let matchingComments = this._comments.filter(comment => path.resolve(this._repository.path, comment.path) === fileName);
			if (matchingComments && matchingComments.length) {
				return {
					bubble: true,
					abbreviation: '♪♪',
					title: '♪♪'
				};
			}
		}

		return {};
	}

	private registerCommentProvider() {
		this._documentCommentProvider = vscode.workspace.registerDocumentCommentProvider({
			onDidChangeCommentThreads: this._onDidChangeCommentThreads.event,
			provideDocumentComments: async (document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CommentInfo> => {
				let ranges: vscode.Range[] = [];
				let matchingComments: Comment[];

				if (document.uri.scheme === 'file') {
					// local file, we only provide active comments.
					const fileName = document.uri.fsPath;
					const matchedFiles = this._localFileChanges.filter(fileChange => path.resolve(this._repository.path, fileChange.fileName) === fileName);
					if (matchedFiles && matchedFiles.length) {
						const matchedFile = matchedFiles[0];

						let contentDiff: string;
						if (document.isDirty) {
							const documentText = document.getText();
							const idAtLastCommit = await this._repository.getFileObjectId(this._lastCommitSha, matchedFile.fileName);
							const idOfCurrentText = await this._repository.hashObject(documentText);

							// git diff <blobid> <blobid>
							contentDiff = await this._repository.diffHashed(idAtLastCommit, idOfCurrentText);
						} else {
							// git diff sha -- fileName
							contentDiff = await this._repository.diff(matchedFile.fileName, this._lastCommitSha);
						}

						matchingComments = this._comments.filter(comment => path.resolve(this._repository.path, comment.path) === fileName);
						matchingComments = mapCommentsToHead(matchedFile.diffHunks, contentDiff, matchingComments);

						let diffHunks = matchedFile.diffHunks;

						for (let i = 0; i < diffHunks.length; i++) {
							let diffHunk = diffHunks[i];
							let start = mapOldPositionToNew(contentDiff, diffHunk.newLineNumber);
							let end = mapOldPositionToNew(contentDiff, diffHunk.newLineNumber + diffHunk.newLength - 1);
							if (start > 0 && end > 0) {
								ranges.push(new vscode.Range(start - 1, 0, end - 1, 0));
							}
						}
					}

					return {
						threads: this.commentsToCommentThreads(matchingComments, vscode.CommentThreadCollapsibleState.Collapsed),
						commentingRanges: ranges,
					};
				}

				if (document.uri.scheme === 'review') {
					let matchedFile = this.findMatchedFileChange(this._localFileChanges, document.uri);

					if (matchedFile) {
						let matchingComments = matchedFile.comments;
						matchingComments.forEach(comment => {
							let diffLine = getDiffLineByPosition(matchedFile.diffHunks, comment.position === null ? comment.original_position : comment.position);

							if (diffLine) {
								comment.absolutePosition = diffLine.newLineNumber;
							}
						});

						let diffHunks = matchedFile.diffHunks;

						for (let i = 0; i < diffHunks.length; i++) {
							let diffHunk = diffHunks[i];
							ranges.push(new vscode.Range(diffHunk.newLineNumber, 1, diffHunk.newLineNumber + diffHunk.newLength - 1, 1));
						}

						return {
							threads: this.commentsToCommentThreads(matchingComments, vscode.CommentThreadCollapsibleState.Expanded),
							commentingRanges: ranges,
						};
					}

					// comments are outdated
					matchedFile = this.findMatchedFileChange(this._obsoleteFileChanges, document.uri);
					if (!matchedFile) {
						return null;
					}


					let sections = groupBy(matchedFile.comments, comment => comment.original_position); // comment.position is null in this case.
					let ret: vscode.CommentThread[] = [];
					for (let i in sections) {
						let comments = sections[i];
						const comment = comments[0];
						let diffLine = getLastDiffLine(comment.diff_hunk);
						const pos = new vscode.Position(diffLine.newLineNumber - 1, 0);
						const range = new vscode.Range(pos, pos);

						ret.push({
							threadId: comment.id,
							resource: matchedFile.filePath,
							range,
							comments: comments.map(comment => {
								return {
									commentId: comment.id,
									body: new vscode.MarkdownString(comment.body),
									userName: comment.user.login,
									gravatar: comment.user.avatar_url
								};
							}),
							collapsibleState: vscode.CommentThreadCollapsibleState.Expanded
						});


						return {
							threads: ret
						};
					}
				}
			},
			createNewCommentThread: this.createNewCommentThread.bind(this),
			replyToCommentThread: this.replyToCommentThread.bind(this)
		});

		this._workspaceCommentProvider = vscode.workspace.registerWorkspaceCommentProvider({
			onDidChangeCommentThreads: this._onDidChangeCommentThreads.event,
			provideWorkspaceComments: async (token: vscode.CancellationToken) => {
				const comments = await Promise.all(this._localFileChanges.map(async fileChange => {
					return this.commentsToCommentThreads(fileChange.comments);
				}));
				const outdatedComments = this._obsoleteFileChanges.map(fileChange => {
					return this.outdatedCommentsToCommentThreads(fileChange, fileChange.comments);
				});
				return [...comments, ...outdatedComments].reduce((prev, curr) => prev.concat(curr), []);
			},
			createNewCommentThread: this.createNewCommentThread.bind(this),
			replyToCommentThread: this.replyToCommentThread.bind(this)
		});
	}

	private findMatchedFileChange(fileChanges: PRFileChangeNode[], uri: vscode.Uri) {
		let query = JSON.parse(uri.query);
		let matchedFiles = fileChanges.filter(fileChange => {
			if (fileChange.fileName !== query.path) {
				return false;
			}

			let q = JSON.parse(fileChange.filePath.query);

			if (q.commit !== query.commit) {
				return false;
			}
			return true;
		});

		if (matchedFiles && matchedFiles.length) {
			return matchedFiles[0];
		}

		return null;
	}

	public async switch(pr: PullRequestModel): Promise<void> {
		Logger.appendLine(`Review> swtich to Pull Requet #${pr.prNumber}`);
		let isDirty = await this._repository.isDirty();
		if (isDirty) {
			vscode.window.showErrorMessage('Your local changes would be overwritten by checkout, please commit your changes or stash them before you switch branches');
			return;
		}

		this.statusBarItem.text = '$(sync~spin) Switching to Review Mode';
		this.statusBarItem.command = null;
		this.statusBarItem.show();

		try {
			let localBranchInfo = await PullRequestGitHelper.getBranchForPullRequestFromExistingRemotes(this._repository, pr);

			if (localBranchInfo) {
				Logger.appendLine(`Review> there is already one local branch ${localBranchInfo.remote.remoteName}/${localBranchInfo.branch} associated with Pull Request #${pr.prNumber}`);
				await PullRequestGitHelper.checkout(this._repository, localBranchInfo.remote, localBranchInfo.branch, pr);
			} else {
				Logger.appendLine(`Review> there is no local branch associated with Pull Request #${pr.prNumber}, we will create a new branch.`);
				await PullRequestGitHelper.createAndCheckout(this._repository, pr);
			}
		} catch (e) {
			Logger.appendLine(`Review> checkout failed #${JSON.stringify(e)}`);

			if (e.gitErrorCode) {
				// for known git errors, we should provide actions for users to continue.
				if (e.gitErrorCode === GitErrorCodes.LocalChangesOverwritten) {
					vscode.window.showErrorMessage('Your local changes would be overwritten by checkout, please commit your changes or stash them before you switch branches');
					return;
				}
			}

			vscode.window.showErrorMessage(e);
			// todo, we should try to recover, for example, git checkout succeeds but set config fails.
			return;
		}

		await this._repository.status();
		await this.validateState();
	}

	private clear(quitReviewMode: boolean) {
		this._prNumber = null;
		this._pr = null;
		this._updateMessageShown = false;

		if (this._documentCommentProvider) {
			this._documentCommentProvider.dispose();
		}

		if (this._workspaceCommentProvider) {
			this._workspaceCommentProvider.dispose();
		}

		if (quitReviewMode) {
			if (this._statusBarItem) {
				this._statusBarItem.hide();
			}

			if (this._prFileChangesProvider) {
				this.prFileChangesProvider.hide();
			}

			// Ensure file explorer decorations are removed. When switching to a different PR branch,
			// comments are recalculated when getting the data and the change decoration fired then,
			// so comments only needs to be emptied in this case.
			this._comments = [];
			this._onDidChangeDecorations.fire();
		}

		vscode.commands.executeCommand('pr.refreshList');
	}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		let { path, commit } = fromGitUri(uri);
		let changedItems = this._localFileChanges
			.filter(change => change.fileName === path)
			.filter(fileChange => fileChange.sha === commit || (fileChange.parentSha ? fileChange.parentSha : `${fileChange.sha}^`) === commit);

		if (changedItems.length) {
			let changedItem = changedItems[0];
			let diffChangeTypeFilter = commit === changedItem.sha ? DiffChangeType.Delete : DiffChangeType.Add;
			let ret = changedItem.diffHunks.map(diffHunk => diffHunk.diffLines.filter(diffLine => diffLine.type !== diffChangeTypeFilter).map(diffLine => diffLine.text));
			return ret.reduce((prev, curr) => prev.concat(...curr), []).join('\n');
		}

		changedItems = this._obsoleteFileChanges
			.filter(change => change.fileName === path)
			.filter(fileChange => fileChange.sha === commit || (fileChange.parentSha ? fileChange.parentSha : `${fileChange.sha}^`) === commit);

		if (changedItems.length) {
			// it's from obsolete file changes, which means the content is in complete.
			let changedItem = changedItems[0];
			let diffChangeTypeFilter = commit === changedItem.sha ? DiffChangeType.Delete : DiffChangeType.Add;
			let ret = [];
			let commentGroups = groupBy(changedItem.comments, comment => comment.original_position);

			for (let comment_position in commentGroups) {
				let lines = commentGroups[comment_position][0].diff_hunks
					.map(diffHunk =>
						diffHunk.diffLines.filter(diffLine => diffLine.type !== diffChangeTypeFilter)
							.map(diffLine => diffLine.text)
					).reduce((prev, curr) => prev.concat(...curr), []);
				ret.push(...lines);
			}

			return ret.join('\n');
		}

		return null;
	}

	dispose() {
		this.clear(true);
		this._disposables.forEach(dispose => {
			dispose.dispose();
		});
	}
}