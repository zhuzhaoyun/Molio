import { useState, useCallback, useEffect } from 'react';
import type { Project, Conversation } from '@kge/contracts';
import { api } from '../api/client';

interface UseProjectsReturn {
  projects: Project[];
  activeProject: Project | null;
  conversations: Conversation[];
  activeConversationId: string | null;
  loading: boolean;
  selectProject: (project: Project) => void;
  createProject: (name: string) => Promise<Project>;
  selectConversation: (id: string | null) => void;
  createConversation: (title?: string) => Promise<Conversation>;
  refresh: () => Promise<void>;
}

export function useProjects(): UseProjectsReturn {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProjects = useCallback(async () => {
    try {
      const list = await api.listProjects();
      setProjects(list);
      // Auto-select first project if none selected
      if (list.length > 0 && !activeProject) {
        setActiveProject(list[0]!);
      }
    } catch (err) {
      console.error('Failed to load projects:', err);
    }
  }, [activeProject]);

  const loadConversations = useCallback(async (projectId: string) => {
    try {
      const list = await api.listConversations(projectId);
      setConversations(list);
    } catch (err) {
      console.error('Failed to load conversations:', err);
    }
  }, []);

  // Load projects on mount
  useEffect(() => {
    setLoading(true);
    loadProjects().finally(() => setLoading(false));
  }, [loadProjects]);

  // Load conversations when project changes
  useEffect(() => {
    if (activeProject) {
      loadConversations(activeProject.id);
    }
  }, [activeProject, loadConversations]);

  const selectProject = useCallback((project: Project) => {
    setActiveProject(project);
    setActiveConversationId(null);
    setConversations([]);
  }, []);

  const createProject = useCallback(async (name: string): Promise<Project> => {
    const project = await api.createProject(name);
    setProjects((prev) => [project, ...prev]);
    setActiveProject(project);
    return project;
  }, []);

  const selectConversation = useCallback((id: string | null) => {
    setActiveConversationId(id);
  }, []);

  const createConversation = useCallback(async (title?: string): Promise<Conversation> => {
    if (!activeProject) throw new Error('No active project');
    const conv = await api.createConversation(activeProject.id, title);
    setConversations((prev) => [conv, ...prev]);
    setActiveConversationId(conv.id);
    return conv;
  }, [activeProject]);

  const refresh = useCallback(async () => {
    await loadProjects();
    if (activeProject) {
      await loadConversations(activeProject.id);
    }
  }, [loadProjects, loadConversations, activeProject]);

  return {
    projects,
    activeProject,
    conversations,
    activeConversationId,
    loading,
    selectProject,
    createProject,
    selectConversation,
    createConversation,
    refresh,
  };
}
