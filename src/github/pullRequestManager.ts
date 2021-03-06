/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CredentialStore } from "./credentials";
import { Comment } from "../common/comment";
import { Remote } from "../common/remote";
import { Repository } from "../common/repository";
import { TimelineEvent, EventType } from "../common/timelineEvent";
import { GitHubRepository, PULL_REQUEST_PAGE_SIZE } from "./githubRepository";
import { IPullRequestManager, IPullRequestModel, IPullRequestsPagingOptions, PRType, Commit, FileChange, ReviewEvent } from "./interface";
import { PullRequestGitHelper } from "./pullRequestGitHelper";
import { PullRequestModel } from "./pullRequestModel";
import { parserCommentDiffHunk } from "../common/diffHunk";
import { Configuration } from '../authentication/configuration';
import { GitHubManager } from '../authentication/githubServer';
import { formatError, uniqBy } from '../common/utils';

interface PageInformation {
	pullRequestPage: number;
	hasMorePages: boolean;
}

export class PullRequestManager implements IPullRequestManager {
	private _activePullRequest?: IPullRequestModel;
	private _credentialStore: CredentialStore;
	private _githubRepositories: GitHubRepository[];
	private _githubManager: GitHubManager;
	private _repositoryPageInformation: Map<string, PageInformation> = new Map<string, PageInformation>();

	private _onDidChangeActivePullRequest = new vscode.EventEmitter<void>();
	readonly onDidChangeActivePullRequest: vscode.Event<void> = this._onDidChangeActivePullRequest.event;

	constructor(private _configuration: Configuration, private _repository: Repository) {
		this._githubRepositories = [];
		this._credentialStore = new CredentialStore(this._configuration);
		this._githubManager = new GitHubManager();
	}

	get activePullRequest() {
		return this._activePullRequest;
	}

	set activePullRequest(pullRequest: IPullRequestModel) {
		this._activePullRequest = pullRequest;
		this._onDidChangeActivePullRequest.fire();
	}

	async clearCredentialCache(): Promise<void> {
		this._credentialStore.reset();
	}

	async updateRepositories(): Promise<void> {
		const potentialRemotes = this._repository.remotes.filter(remote => remote.host);
		let gitHubRemotes = await Promise.all(potentialRemotes.map(remote => this._githubManager.isGitHub(remote.gitProtocol.normalizeUri())))
			.then(results => potentialRemotes.filter((_, index, __) => results[index]));
		gitHubRemotes = uniqBy(gitHubRemotes, remote => remote.gitProtocol.normalizeUri().toString());

		if (gitHubRemotes.length) {
			await vscode.commands.executeCommand('setContext', 'github:hasGitHubRemotes', true);
		} else {
			await vscode.commands.executeCommand('setContext', 'github:hasGitHubRemotes', false);
		}

		let repositories = [];
		for (let remote of gitHubRemotes) {
			const isRemoteForPR = await PullRequestGitHelper.isRemoteCreatedForPullRequest(this._repository, remote.remoteName);
			if (!isRemoteForPR) {
				repositories.push(new GitHubRepository(remote, this._credentialStore));
			}
		}

		this._githubRepositories = repositories;

		for (let repository of this._githubRepositories) {
			const remoteId = repository.remote.url.toString();
			if (!this._repositoryPageInformation.get(remoteId)) {
				this._repositoryPageInformation.set(remoteId, {
					pullRequestPage: 1,
					hasMorePages: null
				});
			}
		}

		return Promise.resolve();
	}

	async authenticate(): Promise<boolean> {
		let ret = false;
		this._credentialStore.reset();
		for (let repository of uniqBy(this._githubRepositories, x => x.remote.normalizedHost)) {
			ret = await repository.authenticate() || ret;
		}
		return ret;
	}

	async getLocalPullRequests(): Promise<IPullRequestModel[]> {
		const githubRepositories = this._githubRepositories;

		if (!githubRepositories || !githubRepositories.length) {
			return [];
		}

		const localBranches = await this._repository.getLocalBranches();

		const promises = localBranches.map(async localBranchName => {
			const matchingPRMetadata = await PullRequestGitHelper.getMatchingPullRequestMetadataForBranch(this._repository, localBranchName);

			if (matchingPRMetadata) {
				const { owner, prNumber } = matchingPRMetadata;
				const githubRepo = githubRepositories.find(repo => repo.remote.owner.toLocaleLowerCase() === owner.toLocaleLowerCase());

				if (githubRepo) {
					const pullRequest: PullRequestModel = await githubRepo.getPullRequest(prNumber);

					if (pullRequest) {
						pullRequest.localBranchName = localBranchName;
						return pullRequest;
					}
				}
			}

			return Promise.resolve(null);
		});

		return Promise.all(promises).then(values => {
			return values.filter(value => value !== null);
		});
	}

	async deleteLocalPullRequest(pullRequest: PullRequestModel): Promise<void> {
		const remoteName = await this._repository.getConfig(`branch.${pullRequest.localBranchName}.remote`);
		if (!remoteName) {
			throw new Error('Unable to find remote for branch');
		}

		const result = await this._repository.run(['branch', '-D', pullRequest.localBranchName]);
		if (result.stderr) {
			throw new Error(result.stderr);
		}

		// If the extension created a remote for the branch, remove it if there are no other branches associated with it
		const isPRRemote = await PullRequestGitHelper.isRemoteCreatedForPullRequest(this._repository, remoteName);
		if (isPRRemote) {
			const configKeyValues = await this._repository.run(['config', '--local', '-l']);
			if (configKeyValues.stderr) {
				throw new Error(configKeyValues.stderr);
			}

			const result = configKeyValues.stdout.trim();
			const hasOtherAssociatedBranches = new RegExp(`^branch.*\.remote=${remoteName}$`, 'm').test(result);

			if (!hasOtherAssociatedBranches) {
				const remoteResult = await this._repository.run(['remote', 'remove', remoteName]);
				if (remoteResult.stderr) {
					throw new Error(remoteResult.stderr);
				}
			}
		}
	}

	async getPullRequests(type: PRType, options: IPullRequestsPagingOptions = { fetchNextPage: false }): Promise<[IPullRequestModel[], boolean]> {
		let githubRepositories = this._githubRepositories;

		if (!githubRepositories || !githubRepositories.length) {
			return [[], false];
		}

		if (!options.fetchNextPage) {
			for (let repository of this._githubRepositories) {
				this._repositoryPageInformation.set(repository.remote.url.toString(), {
					pullRequestPage: 1,
					hasMorePages: null
				});
			}
		}

		githubRepositories = githubRepositories.filter(repo => this._repositoryPageInformation.get(repo.remote.url.toString()).hasMorePages !== false);

		let pullRequests: PullRequestModel[] = [];
		let numPullRequests = 0;
		let hasMorePages = false;

		for (let i = 0; i < githubRepositories.length; i++) {
			if (numPullRequests >= PULL_REQUEST_PAGE_SIZE) {
				hasMorePages = true;
				break;
			}

			const githubRepository = githubRepositories[i];
			const remote = githubRepository.remote.remoteName;
			const isRemoteForPR = await PullRequestGitHelper.isRemoteCreatedForPullRequest(this._repository, remote);
			if (!isRemoteForPR) {
				const pageInformation = this._repositoryPageInformation.get(githubRepository.remote.url.toString());
				while (numPullRequests < PULL_REQUEST_PAGE_SIZE && pageInformation.hasMorePages !== false) {
					const pullRequestData = await githubRepository.getPullRequests(type, pageInformation.pullRequestPage);
					if (!pullRequestData) {
						break;
					}
					numPullRequests += pullRequestData.pullRequests.length;
					pullRequests = pullRequests.concat(...pullRequestData.pullRequests);

					pageInformation.hasMorePages = pullRequestData.hasMorePages;
					hasMorePages = hasMorePages || pageInformation.hasMorePages;
					pageInformation.pullRequestPage++;;
				}
			}
		}

		return [pullRequests, hasMorePages];
	}

	public mayHaveMorePages(): boolean {
		return this._githubRepositories.some(repo => this._repositoryPageInformation.get(repo.remote.url.toString()).hasMorePages !== false);
	}

	async getPullRequestComments(pullRequest: IPullRequestModel): Promise<Comment[]> {
		const {remote, octokit } = await (pullRequest as PullRequestModel).githubRepository.ensure();

		const reviewData = await octokit.pullRequests.getComments({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			per_page: 100
		});
		const rawComments = reviewData.data;
		return parserCommentDiffHunk(rawComments);
	}

	async getPullRequestCommits(pullRequest: IPullRequestModel): Promise<Commit[]> {
		try {
			const {remote, octokit } = await (pullRequest as PullRequestModel).githubRepository.ensure();
			const commitData = await octokit.pullRequests.getCommits({
				number: pullRequest.prNumber,
				owner: remote.owner,
				repo: remote.repositoryName
			});

			return commitData.data;
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching commits failed: ${formatError(e)}`);
			return [];
		}
	}

	async getCommitChangedFiles(pullRequest: IPullRequestModel, commit: Commit): Promise<FileChange[]> {
		try {
			const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();
			const fullCommit = await octokit.repos.getCommit({
				owner: remote.owner,
				repo: remote.repositoryName,
				sha: commit.sha
			});

			return fullCommit.data.files.filter(file => !!file.patch);
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching commit file changes failed: ${formatError(e)}`);
			return [];
		}
	}

	async getReviewComments(pullRequest: IPullRequestModel, reviewId: string): Promise<Comment[]> {
		const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

		const reviewData = await octokit.pullRequests.getReviewComments({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			review_id: reviewId
		});

		const rawComments = reviewData.data;
		return parserCommentDiffHunk(rawComments);
	}

	async getTimelineEvents(pullRequest: IPullRequestModel): Promise<TimelineEvent[]> {
		const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

		let ret = await octokit.issues.getEventsTimeline({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			per_page: 100
		});

		return await parseTimelineEvents(this, pullRequest, ret.data);
	}

	async getIssueComments(pullRequest: IPullRequestModel): Promise<Comment[]> {
		const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

		const promise = await octokit.issues.getComments({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			per_page: 100
		});

		return promise.data;
	}

	async createIssueComment(pullRequest: IPullRequestModel, text: string): Promise<Comment> {
		const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

		const promise = await octokit.issues.createComment({
			body: text,
			number: pullRequest.prNumber,
			owner: remote.owner,
			repo: remote.repositoryName
		});

		return promise.data;
	}

	async createCommentReply(pullRequest: IPullRequestModel, body: string, reply_to: string): Promise<Comment> {
		const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

		try {
			let ret = await octokit.pullRequests.createCommentReply({
				owner: remote.owner,
				repo: remote.repositoryName,
				number: pullRequest.prNumber,
				body: body,
				in_reply_to: Number(reply_to)
			});

			return ret.data;
		} catch (e) {
			if (e.code && e.code === 422) {
				throw new Error('There is already a pending review for this pull request on GitHub. Please finish or dismiss this review to be able to leave more comments');
			} else {
				throw e;
			}
		}
	}

	async createComment(pullRequest: IPullRequestModel, body: string, path: string, position: number): Promise<Comment> {
		const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

		try {
			let ret = await octokit.pullRequests.createComment({
				owner: remote.owner,
				repo: remote.repositoryName,
				number: pullRequest.prNumber,
				body: body,
				commit_id: pullRequest.head.sha,
				path: path,
				position: position
			});

			return ret.data;
		} catch (e) {
			if (e.code && e.code === 422) {
				throw new Error('There is already a pending review for this pull request on GitHub. Please finish or dismiss this review to be able to leave more comments');
			} else {
				throw e;
			}
		}
	}

	async closePullRequest(pullRequest: IPullRequestModel): Promise<any> {
		const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

		let ret = await octokit.pullRequests.update({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			state: 'closed'
		});

		return ret.data;
	}

	private async createReview(pullRequest: IPullRequestModel, event: ReviewEvent, message?: string): Promise<any> {
		const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

		let ret = await octokit.pullRequests.createReview({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			event: event,
			body: message,
		});

		return ret.data;
	}

	async requestChanges(pullRequest: IPullRequestModel, message?: string): Promise<any> {
		return this.createReview(pullRequest, ReviewEvent.RequestChanges, message);
	}

	async approvePullRequest(pullRequest: IPullRequestModel, message?: string): Promise<any> {
		return this.createReview(pullRequest, ReviewEvent.Approve, message);
	}

	async getPullRequestChangedFiles(pullRequest: IPullRequestModel): Promise<FileChange[]> {
		const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

		const { data } = await octokit.pullRequests.getFiles({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber
		});

		return data;
	}

	async getPullRequestRepositoryDefaultBranch(pullRequest: IPullRequestModel): Promise<string> {
		const branch = await (pullRequest as PullRequestModel).githubRepository.getDefaultBranch();
		return branch;
	}

	async fullfillPullRequestMissingInfo(pullRequest: IPullRequestModel): Promise<void> {
		try {
			const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

			if (!pullRequest.base) {
				const { data } = await octokit.pullRequests.get({
					owner: remote.owner,
					repo: remote.repositoryName,
					number: pullRequest.prNumber
				});
				pullRequest.update(data);
			}

			pullRequest.mergeBase = await PullRequestGitHelper.getPullRequestMergeBase(this._repository, remote, pullRequest);
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching Pull Request merge base failed: ${formatError(e)}`);
		}
	}

	//#region Git related APIs

	async resolvePullRequest(owner: string, repositoryName: string, pullReuqestNumber: number): Promise<IPullRequestModel> {
		const githubRepo = this._githubRepositories.find(repo =>
			repo.remote.owner.toLowerCase() === owner.toLowerCase() && repo.remote.repositoryName.toLowerCase() === repositoryName.toLowerCase()
		);

		if (!githubRepo) {
			return null;
		}

		const pr = await githubRepo.getPullRequest(pullReuqestNumber);
		return pr;
	}

	async getMatchingPullRequestMetadataForBranch() {
		if (!this._repository || !this._repository.HEAD) {
			return null;
		}

		let matchingPullRequestMetadata = await PullRequestGitHelper.getMatchingPullRequestMetadataForBranch(this._repository, this._repository.HEAD.name);
		return matchingPullRequestMetadata;
	}

	async getBranchForPullRequestFromExistingRemotes(pullRequest: IPullRequestModel) {
		return await PullRequestGitHelper.getBranchForPullRequestFromExistingRemotes(this._repository, this._githubRepositories, pullRequest);
	}

	async checkout(remote: Remote, branchName: string, pullRequest: IPullRequestModel): Promise<void> {
		await PullRequestGitHelper.checkout(this._repository, remote, branchName, pullRequest);
	}

	async createAndCheckout(pullRequest: IPullRequestModel): Promise<void> {
		await PullRequestGitHelper.createAndCheckout(this._repository, pullRequest);
	}

	//#endregion
}

export function getEventType(text: string) {
	switch (text) {
		case 'committed':
			return EventType.Committed;
		case 'mentioned':
			return EventType.Mentioned;
		case 'subscribed':
			return EventType.Subscribed;
		case 'commented':
			return EventType.Commented;
		case 'reviewed':
			return EventType.Reviewed;
		default:
			return EventType.Other;
	}
}

export async function parseTimelineEvents(pullRequestManager: IPullRequestManager, pullRequest: IPullRequestModel, events: any[]): Promise<TimelineEvent[]> {
	events.forEach(event => {
		let type = getEventType(event.event);
		event.event = type;
		return event;
	});

	await Promise.all(
		events.filter(event => event.event === EventType.Reviewed)
			.map(event => pullRequestManager.getReviewComments(pullRequest, event.id).then(result => {
				event.comments = result;
			})));

	return events;
}