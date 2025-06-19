import { useState, useEffect, useCallback, useRef } from 'react';
import type { Message } from 'ai';
import type { FileMap } from '~/lib/stores/files';
import { repoStore } from '~/lib/stores/repo';
import {
  getProjectCommits,
  fetchProjectFiles,
  getTaskBranches,
  revertBranch,
} from '~/lib/persistenceGitbase/api.client';
import { createScopedLogger } from '~/utils/logger';
import { lastActionStore } from '~/lib/stores/lastAction';

const logger = createScopedLogger('useGitbaseChatHistory');

interface Commit {
  id: string;
  short_id: string;
  title: string;
  message: string;
  author_name: string;
  author_email: string;
  created_at: string;
  committed_date: string;
}

interface PaginationInfo {
  total: number;
  page: number;
  perPage: number;
  hasMore: boolean;
  totalPages: number;
}

interface CommitResponse {
  success: boolean;
  data: {
    project: {
      id: string;
      name: string;
      description: string;
    };
    commits: Commit[];
    pagination: PaginationInfo;
  };
  error?: string;
}

export function useGitbaseChatHistory() {
  const projectPath = repoStore.get().path;
  const [project, setProject] = useState<{
    id: string;
    name: string;
    description: string;
  }>({
    id: '',
    name: '',
    description: '',
  });
  const [chats, setChats] = useState<Message[]>([]);
  const [enabledTaskMode, setEnabledTaskMode] = useState(true);
  const [files, setFiles] = useState<FileMap>({});
  const [taskBranches, setTaskBranches] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingBefore, setLoadingBefore] = useState(false);
  const [filesLoaded, setFilesLoaded] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prevRequestParams = useRef<{ [key: string]: any }>({});

  const loadTaskBranches = useCallback(async (projectPath: string) => {
    const { data } = await getTaskBranches(projectPath);
    setTaskBranches(data);
  }, []);

  const loadFiles = useCallback(
    async (projectPath: string, commitSha?: string) => {
      if (!projectPath) {
        return;
      }

      try {
        setFilesLoaded(false);

        setLoadingFiles(true);

        const fileMap = await fetchProjectFiles(projectPath, commitSha);

        setFiles(fileMap);
        setFilesLoaded(true);
      } catch (fileError) {
        logger.error('Error fetching project files:', fileError);
      } finally {
        setLoadingFiles(false);
      }
    },
    [fetchProjectFiles],
  );

  const load = useCallback(
    async ({
      page = 1,
      taskBranch,
      untilCommit,
      force,
    }: {
      page?: number;
      taskBranch?: string;
      untilCommit?: string;
      force?: boolean;
    }) => {
      if (!projectPath) {
        setLoaded(true);
        setFilesLoaded(true);
        setChats([]);
        setFiles({});

        return;
      }

      logger.debug(`loaded, page: ${page}, taskBranch: ${taskBranch}, untilCommit: ${untilCommit}`);

      if (!force) {
        // 이미 로딩 중이면 종료
        if (loading) {
          return;
        }

        if (
          projectPath === prevRequestParams.current.projectPath &&
          page === prevRequestParams.current.page &&
          taskBranch === prevRequestParams.current.taskBranch &&
          untilCommit === prevRequestParams.current.untilCommit
        ) {
          return;
        }
      }

      if (page === 1) {
        setLoaded(false);
        setLoading(true);
        setError(null);
      } else {
        setLoadingBefore(true);
      }

      try {
        const queryParams = new URLSearchParams({
          projectPath,
          page: page.toString(),
        });

        if (taskBranch) {
          queryParams.append('branch', taskBranch);
        }

        if (untilCommit) {
          queryParams.append('untilCommit', untilCommit);
        }

        prevRequestParams.current = {
          projectPath,
          page,
          taskBranch,
          untilCommit,
        };

        if (page === 1) {
          if (Object.keys(files).length > 0) {
            lastActionStore.set({ action: 'LOAD' });
          }

          await Promise.all([
            loadFiles(projectPath, untilCommit || taskBranch || undefined),
            loadTaskBranches(projectPath),
          ]);
        }

        const data = (await getProjectCommits(projectPath, {
          branch: taskBranch,
          untilCommit,
          page,
        })) as CommitResponse;

        if (!data.success) {
          throw new Error(data.error || 'Failed to fetch commit history');
        }

        setProject(data.data.project);

        const newMessages = parseCommitMessages(data.data.commits);

        if (page > 1) {
          setChats((prevChats) => [...newMessages.reverse(), ...prevChats]);
        } else {
          setChats(newMessages.reverse());
        }

        setLoaded(true);
        setCurrentPage(page);
        setHasMore(data.data.pagination.hasMore);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error fetching commit history');
        logger.error('Error fetching commit history:', err);
      } finally {
        setLoaded(true);
        setLoading(false);
        setLoadingBefore(false);
      }
    },
    [projectPath, loading, fetchProjectFiles],
  );

  // Load more commits
  const loadBefore = useCallback(async () => {
    if (loadingBefore || !hasMore) {
      return;
    }

    await load({
      page: currentPage + 1,
      taskBranch: prevRequestParams.current.taskBranch,
      untilCommit: prevRequestParams.current.untilCommit,
    });
  }, [loading, hasMore, currentPage, load]);

  useEffect(() => {
    const unsubscribe = repoStore.subscribe((state) => {
      if (
        projectPath !== prevRequestParams.current.projectPath ||
        state.taskBranch !== prevRequestParams.current.taskBranch
      ) {
        load({ page: 1, taskBranch: state.taskBranch, untilCommit: undefined });
      }
    });
    return () => unsubscribe();
  }, [load, projectPath]);

  return {
    loaded: loaded && filesLoaded,
    chats,
    revertTo: async (hash: string) => {
      setLoading(true);

      try {
        await revertBranch(projectPath, repoStore.get().taskBranch, hash);
        await load({ page: 1, taskBranch: repoStore.get().taskBranch, untilCommit: hash, force: true });
      } finally {
        setLoading(false);
      }
    },
    project,
    files,
    taskBranches,
    reloadTaskBranches: loadTaskBranches,
    enabledTaskMode,
    setEnabledTaskMode,
    loading: loading || loadingFiles,
    loadingBefore,
    error,
    hasMore,
    loadBefore,
  };
}

const parseCommitMessages = (commits: Commit[]): Message[] => {
  const messages: Message[] = [];

  commits.forEach((commit) => {
    // Use regex to extract assistant message
    const assistantMessageMatch = commit.message.match(/<V8AssistantMessage>([\s\S]*?)<\/V8AssistantMessage>/);
    const assistantMatched = assistantMessageMatch && assistantMessageMatch[1];

    if (assistantMatched) {
      const assistantContent = assistantMessageMatch[1].trim();

      if (assistantContent) {
        messages.push({
          id: `${commit.id}`,
          role: 'assistant',
          content: assistantContent,
          parts: [
            {
              type: 'text',
              text: assistantContent,
            },
          ],
          createdAt: new Date(commit.created_at),
        });
      }
    }

    const userMessageMatch = commit.message.match(/<V8UserMessage>([\s\S]*?)<\/V8UserMessage>/);
    const userMatched = userMessageMatch && userMessageMatch[1];

    if (userMatched) {
      const userContent = userMessageMatch[1].trim();

      if (userContent) {
        messages.push({
          id: `user-${commit.id}`,
          role: 'user',
          content: userContent,
          parts: [
            {
              type: 'text',
              text: userContent,
            },
          ],
          createdAt: new Date(commit.created_at),
        });
      }
    }

    const isInitialCommit = (message: string) => {
      return message.toLowerCase().trim() === 'initial commit' || message.toLowerCase().trim() === 'add readme.md';
    };

    if (!assistantMatched && !userMatched) {
      messages.push({
        id: `commit-${commit.id}`,
        role: 'assistant',
        content: commit.message,
        parts: [
          {
            type: 'text',
            text: commit.message,
          },
        ],
        createdAt: new Date(commit.created_at),
        annotations: isInitialCommit(commit.message) ? ['hidden'] : [],
      });
    }
  });

  return messages;
};
