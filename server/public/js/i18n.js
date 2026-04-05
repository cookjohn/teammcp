const i18n = {
  _lang: localStorage.getItem('tmcp-lang') || 'en',
  en: {
    'auth.title': 'TeamMCP',
    'auth.desc': 'Enter your API key to access the dashboard',
    'auth.placeholder': 'tmcp_...',
    'auth.connect': 'Connect',
    'auth.empty': 'Please enter an API key',
    'auth.connecting': 'Connecting...',
    'auth.failed': 'Authentication failed',
    'header.title': 'TeamMCP Dashboard',
    'sse.connected': 'Connected',
    'sse.disconnected': 'Disconnected',
    'sse.reconnecting': 'Reconnecting...',
    'nav.channels': 'Channels',
    'nav.tasks': 'Tasks',
    'nav.allTasks': 'All Tasks',
    'nav.state': 'State',
    'nav.projectState': 'Project State',
    'nav.agents': 'Agents',
    'nav.agentMgmt': 'Agent Management',
    'channel.select': 'Select a channel to view messages',
    'channel.files': 'Files',
    'channel.members': 'Members',
    'channel.pinnedMessages': 'pinned messages',
    'channel.noPins': 'No pinned messages',
    'channel.dmWith': 'DM with',
    'compose.placeholder': 'Type a message... (@ to mention)',
    'compose.send': 'Send',
    'compose.hint': 'Enter to send, Shift+Enter for new line',
    'compose.sendingTo': 'Sending to',
    'compose.as': 'as',
    'compose.failedSend': 'Failed to send',
    'msg.noMessages': 'No messages yet',
    'msg.loadOlder': 'Load older messages',
    'msg.newMessages': '↓ New messages',
    'msg.edited': '(edited)',
    'msg.replyingTo': 'Replying to',
    'msg.showMore': 'Show more',
    'msg.showLess': 'Show less',
    'msg.pinned': 'pinned',
    'msg.pin': 'Pin',
    'msg.unpin': 'Unpin',
    'tasks.title': 'Tasks',
    'tasks.allStatus': 'All Status',
    'tasks.todo': 'Todo',
    'tasks.doing': 'Doing',
    'tasks.done': 'Done',
    'tasks.allAssignees': 'All Assignees',
    'tasks.newTask': '+ New Task',
    'tasks.loading': 'Loading tasks...',
    'tasks.failed': 'Failed to load tasks',
    'tasks.empty': 'No tasks yet. Click <strong>+ New Task</strong> to create one.',
    'tasks.due': 'Due',
    'tasks.unassigned': 'Unassigned',
    'taskDetail.title': 'Task Detail',
    'taskDetail.titleLabel': 'Title',
    'taskDetail.status': 'Status',
    'taskDetail.priority': 'Priority',
    'taskDetail.creator': 'Creator',
    'taskDetail.assignee': 'Assignee',
    'taskDetail.dueDate': 'Due Date',
    'taskDetail.labels': 'Labels',
    'taskDetail.result': 'Result',
    'taskDetail.resultPlaceholder': 'Enter result...',
    'taskDetail.subtasks': 'Sub-tasks',
    'taskDetail.files': 'Files',
    'taskDetail.created': 'Created',
    'taskDetail.delete': 'Delete Task',
    'taskDetail.confirmDelete': 'Are you sure you want to delete this task?',
    'taskDetail.permissionDenied': 'Permission denied',
    'taskDetail.failedUpdate': 'Failed to update',
    'taskDetail.failedDelete': 'Failed to delete',
    'createTask.title': 'Create New Task',
    'createTask.titleLabel': 'Title *',
    'createTask.titlePlaceholder': 'Task title...',
    'createTask.priority': 'Priority',
    'createTask.assignee': 'Assignee',
    'createTask.dueDate': 'Due Date',
    'createTask.cancel': 'Cancel',
    'createTask.create': 'Create Task',
    'createTask.permissionDenied': 'Permission denied',
    'createTask.failed': 'Failed to create task',
    'priority.urgent': 'Urgent',
    'priority.high': 'High',
    'priority.medium': 'Medium',
    'priority.low': 'Low',
    'state.title': 'Project State',
    'state.autoRefresh': 'Auto-refresh every 15s',
    'state.refresh': 'Refresh',
    'state.auto': 'Auto',
    'state.enterProject': 'Enter a project ID and click refresh to load state',
    'state.totalFields': 'Total Fields',
    'state.activeOwners': 'Active Owners',
    'state.needApproval': 'Need Approval',
    'state.lastUpdated': 'Last Updated',
    'state.stateFields': 'State Fields',
    'state.noFields': 'No state fields found for this project',
    'state.approvalRequired': 'approval required',
    'state.empty': '(empty)',
    'state.recentChanges': 'Recent Changes',
    'state.loading': 'Loading...',
    'state.failedChangelog': 'Failed to load change log',
    'state.noChanges': 'No recent changes',
    'state.created': 'created',
    'state.changed': 'changed',
    'state.changedBy': 'changed by',
    'state.fieldDetail': 'Field Detail',
    'state.field': 'Field',
    'state.value': 'Value',
    'state.owner': 'Owner',
    'state.none': 'None',
    'state.version': 'Version',
    'state.approval': 'Approval',
    'state.subscribers': 'Subscribers',
    'state.changeHistory': 'Change History',
    'state.failedDetail': 'Failed to load field detail',
    'state.pendingApprovals': 'Pending Approvals',
    'state.requestedBy': 'Requested by',
    'state.in': 'in',
    'state.approve': 'Approve',
    'state.reject': 'Reject',
    'state.failedApproval': 'Failed to resolve approval',
    'state.auditReports': 'Audit Reports',
    'state.all': 'All',
    'state.compliance': 'Compliance',
    'state.efficiency': 'Efficiency',
    'state.anomaly': 'Anomaly',
    'state.noReports': 'No reports found',
    'agents.title': 'Agent Management',
    'agents.newAgent': '+ New Agent',
    'agents.total': 'Total Agents',
    'agents.online': 'Online',
    'agents.offline': 'Offline',
    'agents.orgTree': 'Organization Tree',
    'agents.noAgents': 'No agents found',
    'agents.allAgents': 'All Agents',
    'agents.lastSeen': 'Last seen',
    'agents.viewOutput': 'View Output',
    'agentDetail.title': 'Agent Detail',
    'agentDetail.name': 'Name',
    'agentDetail.role': 'Role',
    'agentDetail.status': 'Status',
    'agentDetail.reportsTo': 'Reports To',
    'agentDetail.noneRoot': 'None (Root)',
    'agentDetail.lastSeen': 'Last Seen',
    'agentDetail.resume': 'Session Resume',
    'agentDetail.resumeOn': 'Resume: ON',
    'agentDetail.resumeOff': 'Resume: OFF',
    'agentDetail.config': 'Configuration',
    'agentDetail.authMode': 'Auth Mode',
    'agentDetail.oauth': 'OAuth (Default)',
    'agentDetail.apiKey': 'API Key',
    'agentDetail.provider': 'API Provider',
    'agentDetail.select': 'Select...',
    'agentDetail.baseUrl': 'API Base URL',
    'agentDetail.token': 'API Auth Token',
    'agentDetail.tokenPlaceholder': 'Enter new token (leave empty to keep)',
    'agentDetail.model': 'Model',
    'agentDetail.save': 'Save Changes',
    'agentDetail.saving': 'Saving...',
    'agentDetail.saved': 'Saved \u2713',
    'agentDetail.failedSave': 'Failed to save',
    'agentDetail.stop': 'Stop Agent',
    'agentDetail.start': 'Start Agent',
    'agentDetail.delete': 'Delete Agent',
    'agentDetail.confirmDelete1': 'Are you sure you want to delete agent',
    'agentDetail.confirmDelete2': 'This will permanently remove the agent and all associated data.',
    'agentDetail.failedDelete': 'Failed to delete agent',
    'agentDetail.logsErrors': 'Logs & Errors',
    'agentDetail.output': 'Output',
    'agentDetail.errors': 'Errors',
    'agentDetail.noOutput': 'No output logs',
    'agentDetail.noErrors': 'No errors',
    'agentDetail.failedLogs': 'Failed to load logs',
    'createAgent.title': 'Register New Agent',
    'createAgent.name': 'Agent Name *',
    'createAgent.namePlaceholder': 'e.g. DevOps',
    'createAgent.role': 'Role',
    'createAgent.rolePlaceholder': 'e.g. DevOps Engineer',
    'createAgent.reportsTo': 'Reports To',
    'createAgent.secret': 'Registration Secret',
    'createAgent.secretPlaceholder': 'Leave empty if not required',
    'createAgent.authConfig': 'Authentication Config',
    'createAgent.cancel': 'Cancel',
    'createAgent.register': 'Register',
    'createAgent.nameRequired': 'Agent name is required',
    'createAgent.success': 'Agent registered!',
    'createAgent.apiKeyLabel': 'API Key',
    'createAgent.saveWarning': 'Save this key - it cannot be retrieved later.',
    'createAgent.error': 'Error',
    'files.failed': 'Failed to load file events',
    'files.empty': 'No file activity yet',
    'members.title': 'Members',
    'members.selectAgent': 'Select agent...',
    'members.failedLoad': 'Failed to load members',
    'members.failedAdd': 'Failed to add member',
    'members.confirmRemove': 'Remove from this channel?',
    'members.noMembers': 'No members found',
    'members.failedRemove': 'Failed to remove member',
    'agent.starting': 'Starting...',
    'agent.stopping': 'Stopping...',
    'agent.start': 'Start',
    'agent.stop': 'Stop',
    'agent.confirmStop': 'Stop agent',
    'agent.startFailed': 'Start failed',
    'agent.stopFailed': 'Stop failed',
    'agent.failed': 'Failed',
    'agent.you': 'You',
    'agent.clickDm': 'Click to DM',
    'agent.self': '(you)',
    'agent.outputTitle': 'Agent Output',
    'agent.noOutput': 'No output yet',
    'activity.using': 'Using',
    'activity.thinking': 'Thinking...',
    'general.updated': 'Updated',
    'general.today': 'Today',
    'general.yesterday': 'Yesterday',
    'theme.light': 'Light',
    'theme.dark': 'Dark',
    'wizard.next': 'Next',
    'wizard.back': 'Back',
    'wizard.enter': 'Enter Dashboard',
    'wizard.welcomeTitle': 'Welcome to TeamMCP',
    'wizard.welcomeDesc': 'Set up your AI agent collaboration platform in a few simple steps.',
    'wizard.configTitle': 'Basic Configuration',
    'wizard.configDesc': 'Configure the server.',
    'wizard.agentsDir': 'Agents Directory',
    'wizard.port': 'Server Port',
    'wizard.secret': 'Registration Secret (optional)',
    'wizard.secretPlaceholder': 'Leave empty for open registration',
    'wizard.profileTitle': 'How Should We Call You?',
    'wizard.profileDesc': 'Register yourself as the team leader.',
    'wizard.userName': 'Your Name',
    'wizard.userRole': 'Your Role',
    'wizard.userNamePlaceholder': 'e.g. Chairman',
    'wizard.userRolePlaceholder': 'e.g. Team Leader',
    'wizard.defaultUserName': 'Chairman',
    'wizard.defaultUserRole': 'Chairman',
    'wizard.agentTitle': 'Create First Agent',
    'wizard.agentDesc': 'Register yourself to get started.',
    'wizard.configAgentTitle': 'Create a Working Agent',
    'wizard.configAgentDesc': 'Create a working agent with authentication to start serving tasks.',
    'wizard.agentAuthMode': 'Authentication Mode',
    'wizard.authModeOauth': 'OAuth (Default)',
    'wizard.authModeApiKey': 'API Key',
    'wizard.apiProvider': 'API Provider',
    'wizard.apiBaseUrl': 'API Base URL',
    'wizard.apiAuthToken': 'API Auth Token',
    'wizard.apiModel': 'Model',
    'wizard.agentNameInvalid': 'Agent name contains invalid characters.',
    'wizard.agentName': 'Agent Name',
    'wizard.agentRole': 'Role',
    'wizard.agentNamePlaceholder': 'e.g. Chairman',
    'wizard.agentRolePlaceholder': 'e.g. AI Assistant',
    'wizard.defaultAgentName': 'Chairman',
    'wizard.defaultAgentRole': 'AI Assistant',
    'wizard.completeTitle': 'Setup Complete!',
    'wizard.completeDesc': 'Your team is ready. Save the API key below.',
    'wizard.tourTitle': 'Dashboard Overview',
    'wizard.tourDesc': 'Here\'s what you can do with TeamMCP Dashboard.',
    'wizard.tourChannels': 'Channels',
    'wizard.tourChannelsDesc': 'Group chat and DM with your AI agents in real-time.',
    'wizard.tourTasks': 'Task Management',
    'wizard.tourTasksDesc': 'Create, assign, and track tasks across your team.',
    'wizard.tourAgents': 'Agent Management',
    'wizard.tourAgentsDesc': 'Register, start/stop, and configure agents. View org tree.',
    'wizard.tourState': 'Project State',
    'wizard.tourStateDesc': 'Track project status, approvals, and audit reports.',
    'wizard.apiKey': 'API Key (click to copy)',
    'wizard.nextSteps': 'Next Steps:',
    'wizard.stepInstall': 'Run <code>npm start</code> to launch the server',
    'wizard.stepVisit': 'Open <code>http://localhost:{port}</code>',
    'wizard.stepShare': 'Share the API key with your team members',
    'wizard.registerFailed': 'Registration failed: ',
    'wizard.nameRequired': 'Agent name is required',
    'wizard.nameInvalid': 'Invalid agent name (letters, digits, -, _ only)',
    'wizard.configSaved': 'Configuration saved.',
    'wizard.skip': 'Skip',
    'wechat.connected': 'Connected',
    'wechat.disconnected': 'Disconnected',
    'wechat.scanning': 'Scanning...',
    'wechat.bind': 'Bind WeChat',
    'wechat.disconnect': 'Disconnect',
    'wechat.cancel': 'Cancel',
    'wechat.scanHint': 'Scan with WeChat to bind',
    'wechat.confirmDisconnect': 'Disconnect WeChat binding?',
    'wechat.bindFailed': 'WeChat binding failed',
    'wechat.disconnectFailed': 'Failed to disconnect',
  },
  zh: {
    'auth.title': 'TeamMCP',
    'auth.desc': '\u8f93\u5165 API Key \u8bbf\u95ee\u63a7\u5236\u53f0',
    'auth.placeholder': 'tmcp_...',
    'auth.connect': '\u8fde\u63a5',
    'auth.empty': '\u8bf7\u8f93\u5165 API Key',
    'auth.connecting': '\u8fde\u63a5\u4e2d...',
    'auth.failed': '\u8ba4\u8bc1\u5931\u8d25',
    'header.title': 'TeamMCP \u63a7\u5236\u53f0',
    'sse.connected': '\u5df2\u8fde\u63a5',
    'sse.disconnected': '\u672a\u8fde\u63a5',
    'sse.reconnecting': '\u91cd\u8fde\u4e2d...',
    'nav.channels': '\u9891\u9053',
    'nav.tasks': '\u4efb\u52a1',
    'nav.allTasks': '\u5168\u90e8\u4efb\u52a1',
    'nav.state': '\u72b6\u6001',
    'nav.projectState': '\u9879\u76ee\u72b6\u6001',
    'nav.agents': '\u6210\u5458',
    'nav.agentMgmt': '\u6210\u5458\u7ba1\u7406',
    'channel.select': '\u9009\u62e9\u4e00\u4e2a\u9891\u9053\u67e5\u770b\u6d88\u606f',
    'channel.files': '\u6587\u4ef6',
    'channel.members': '\u6210\u5458',
    'channel.pinnedMessages': '\u6761\u7f6e\u9876\u6d88\u606f',
    'channel.noPins': '\u6682\u65e0\u7f6e\u9876\u6d88\u606f',
    'channel.dmWith': '\u4e0e',
    'compose.placeholder': '\u8f93\u5165\u6d88\u606f... (@ \u63d0\u53ca)',
    'compose.send': '\u53d1\u9001',
    'compose.hint': 'Enter \u53d1\u9001\uff0cShift+Enter \u6362\u884c',
    'compose.sendingTo': '\u53d1\u9001\u5230',
    'compose.as': '\u8eab\u4efd',
    'compose.failedSend': '\u53d1\u9001\u5931\u8d25',
    'msg.noMessages': '\u6682\u65e0\u6d88\u606f',
    'msg.loadOlder': '\u52a0\u8f7d\u66f4\u65e9\u6d88\u606f',
    'msg.newMessages': '↓ \u6709\u65b0\u6d88\u606f',
    'msg.edited': '(\u5df2\u7f16\u8f91)',
    'msg.replyingTo': '\u56de\u590d',
    'msg.showMore': '\u5c55\u5f00',
    'msg.showLess': '\u6536\u8d77',
    'msg.pinned': '\u5df2\u7f6e\u9876',
    'msg.pin': '\u7f6e\u9876',
    'msg.unpin': '\u53d6\u6d88\u7f6e\u9876',
    'tasks.title': '\u4efb\u52a1',
    'tasks.allStatus': '\u5168\u90e8\u72b6\u6001',
    'tasks.todo': '\u5f85\u529e',
    'tasks.doing': '\u8fdb\u884c\u4e2d',
    'tasks.done': '\u5df2\u5b8c\u6210',
    'tasks.allAssignees': '\u5168\u90e8\u8d1f\u8d23\u4eba',
    'tasks.newTask': '+ \u65b0\u5efa\u4efb\u52a1',
    'tasks.loading': '\u52a0\u8f7d\u4efb\u52a1\u4e2d...',
    'tasks.failed': '\u52a0\u8f7d\u4efb\u52a1\u5931\u8d25',
    'tasks.empty': '\u6682\u65e0\u4efb\u52a1\uff0c\u70b9\u51fb <strong>+ \u65b0\u5efa\u4efb\u52a1</strong> \u521b\u5efa\u3002',
    'tasks.due': '\u622a\u6b62',
    'tasks.unassigned': '\u672a\u5206\u914d',
    'taskDetail.title': '\u4efb\u52a1\u8be6\u60c5',
    'taskDetail.titleLabel': '\u6807\u9898',
    'taskDetail.status': '\u72b6\u6001',
    'taskDetail.priority': '\u4f18\u5148\u7ea7',
    'taskDetail.creator': '\u521b\u5efa\u8005',
    'taskDetail.assignee': '\u8d1f\u8d23\u4eba',
    'taskDetail.dueDate': '\u622a\u6b62\u65e5\u671f',
    'taskDetail.labels': '\u6807\u7b7e',
    'taskDetail.result': '\u7ed3\u679c',
    'taskDetail.resultPlaceholder': '\u8f93\u5165\u7ed3\u679c...',
    'taskDetail.subtasks': '\u5b50\u4efb\u52a1',
    'taskDetail.files': '\u6587\u4ef6',
    'taskDetail.created': '\u521b\u5efa\u65f6\u95f4',
    'taskDetail.delete': '\u5220\u9664\u4efb\u52a1',
    'taskDetail.confirmDelete': '\u786e\u5b9a\u8981\u5220\u9664\u8fd9\u4e2a\u4efb\u52a1\u5417\uff1f',
    'taskDetail.permissionDenied': '\u6743\u9650\u4e0d\u8db3',
    'taskDetail.failedUpdate': '\u66f4\u65b0\u5931\u8d25',
    'taskDetail.failedDelete': '\u5220\u9664\u5931\u8d25',
    'createTask.title': '\u521b\u5efa\u65b0\u4efb\u52a1',
    'createTask.titleLabel': '\u6807\u9898 *',
    'createTask.titlePlaceholder': '\u4efb\u52a1\u6807\u9898...',
    'createTask.priority': '\u4f18\u5148\u7ea7',
    'createTask.assignee': '\u8d1f\u8d23\u4eba',
    'createTask.dueDate': '\u622a\u6b62\u65e5\u671f',
    'createTask.cancel': '\u53d6\u6d88',
    'createTask.create': '\u521b\u5efa\u4efb\u52a1',
    'createTask.permissionDenied': '\u6743\u9650\u4e0d\u8db3',
    'createTask.failed': '\u521b\u5efa\u4efb\u52a1\u5931\u8d25',
    'priority.urgent': '\u7d27\u6025',
    'priority.high': '\u9ad8',
    'priority.medium': '\u4e2d',
    'priority.low': '\u4f4e',
    'state.title': '\u9879\u76ee\u72b6\u6001',
    'state.autoRefresh': '\u6bcf15\u79d2\u81ea\u52a8\u5237\u65b0',
    'state.refresh': '\u5237\u65b0',
    'state.auto': '\u81ea\u52a8',
    'state.enterProject': '\u8f93\u5165\u9879\u76ee ID \u5e76\u70b9\u51fb\u5237\u65b0\u52a0\u8f7d\u72b6\u6001',
    'state.totalFields': '\u5b57\u6bb5\u603b\u6570',
    'state.activeOwners': '\u6d3b\u8dc3\u8d1f\u8d23\u4eba',
    'state.needApproval': '\u5f85\u5ba1\u6279',
    'state.lastUpdated': '\u6700\u540e\u66f4\u65b0',
    'state.stateFields': '\u72b6\u6001\u5b57\u6bb5',
    'state.noFields': '\u8be5\u9879\u76ee\u672a\u627e\u5230\u72b6\u6001\u5b57\u6bb5',
    'state.approvalRequired': '\u9700\u8981\u5ba1\u6279',
    'state.empty': '(\u7a7a)',
    'state.recentChanges': '\u6700\u8fd1\u53d8\u66f4',
    'state.loading': '\u52a0\u8f7d\u4e2d...',
    'state.failedChangelog': '\u52a0\u8f7d\u53d8\u66f4\u8bb0\u5f55\u5931\u8d25',
    'state.noChanges': '\u6682\u65e0\u6700\u8fd1\u53d8\u66f4',
    'state.created': '\u521b\u5efa',
    'state.changed': '\u53d8\u66f4',
    'state.changedBy': '\u53d8\u66f4\u8005',
    'state.fieldDetail': '\u5b57\u6bb5\u8be6\u60c5',
    'state.field': '\u5b57\u6bb5',
    'state.value': '\u503c',
    'state.owner': '\u8d1f\u8d23\u4eba',
    'state.none': '\u65e0',
    'state.version': '\u7248\u672c',
    'state.approval': '\u5ba1\u6279',
    'state.subscribers': '\u8ba2\u9605\u8005',
    'state.changeHistory': '\u53d8\u66f4\u5386\u53f2',
    'state.failedDetail': '\u52a0\u8f7d\u5b57\u6bb5\u8be6\u60c5\u5931\u8d25',
    'state.pendingApprovals': '\u5f85\u5904\u7406\u5ba1\u6279',
    'state.requestedBy': '\u8bf7\u6c42\u8005',
    'state.in': '\u5728',
    'state.approve': '\u6279\u51c6',
    'state.reject': '\u62d2\u7edd',
    'state.failedApproval': '\u5904\u7406\u5ba1\u6279\u5931\u8d25',
    'state.auditReports': '\u5ba1\u8ba1\u62a5\u544a',
    'state.all': '\u5168\u90e8',
    'state.compliance': '\u5408\u89c4',
    'state.efficiency': '\u6548\u7387',
    'state.anomaly': '\u5f02\u5e38',
    'state.noReports': '\u6682\u65e0\u62a5\u544a',
    'agents.title': '\u6210\u5458\u7ba1\u7406',
    'agents.newAgent': '+ \u65b0\u589e\u6210\u5458',
    'agents.total': '\u603b\u6570',
    'agents.online': '\u5728\u7ebf',
    'agents.offline': '\u79bb\u7ebf',
    'agents.orgTree': '\u7ec4\u7ec7\u67b6\u6784',
    'agents.noAgents': '\u6682\u65e0\u6210\u5458',
    'agents.allAgents': '\u5168\u90e8\u6210\u5458',
    'agents.lastSeen': '\u6700\u540e\u5728\u7ebf',
    'agents.viewOutput': '\u67e5\u770b\u65e5\u5fd7',
    'agentDetail.title': '\u6210\u5458\u8be6\u60c5',
    'agentDetail.name': '\u540d\u79f0',
    'agentDetail.role': '\u89d2\u8272',
    'agentDetail.status': '\u72b6\u6001',
    'agentDetail.reportsTo': '\u4e0a\u7ea7',
    'agentDetail.noneRoot': '\u65e0 (\u6839\u8282\u70b9)',
    'agentDetail.lastSeen': '\u6700\u540e\u5728\u7ebf',
    'agentDetail.resume': '\u4f1a\u8bdd\u6062\u590d',
    'agentDetail.resumeOn': '\u6062\u590d: \u5f00',
    'agentDetail.resumeOff': '\u6062\u590d: \u5173',
    'agentDetail.config': '\u914d\u7f6e',
    'agentDetail.authMode': '\u8ba4\u8bc1\u6a21\u5f0f',
    'agentDetail.oauth': 'OAuth (\u9ed8\u8ba4)',
    'agentDetail.apiKey': 'API Key',
    'agentDetail.provider': 'API \u63d0\u4f9b\u5546',
    'agentDetail.select': '\u9009\u62e9...',
    'agentDetail.baseUrl': 'API \u5730\u5740',
    'agentDetail.token': 'API \u4ee4\u724c',
    'agentDetail.tokenPlaceholder': '\u8f93\u5165\u65b0\u4ee4\u724c (\u7559\u7a7a\u4fdd\u6301\u4e0d\u53d8)',
    'agentDetail.model': '\u6a21\u578b',
    'agentDetail.save': '\u4fdd\u5b58\u4fee\u6539',
    'agentDetail.saving': '\u4fdd\u5b58\u4e2d...',
    'agentDetail.saved': '\u5df2\u4fdd\u5b58 \u2713',
    'agentDetail.failedSave': '\u4fdd\u5b58\u5931\u8d25',
    'agentDetail.stop': '\u505c\u6b62',
    'agentDetail.start': '\u542f\u52a8',
    'agentDetail.delete': '\u5220\u9664\u6210\u5458',
    'agentDetail.confirmDelete1': '\u786e\u5b9a\u8981\u5220\u9664\u6210\u5458',
    'agentDetail.confirmDelete2': '\u6b64\u64cd\u4f5c\u5c06\u6c38\u4e45\u79fb\u9664\u8be5\u6210\u5458\u53ca\u6240\u6709\u5173\u8054\u6570\u636e\u3002',
    'agentDetail.failedDelete': '\u5220\u9664\u6210\u5458\u5931\u8d25',
    'agentDetail.logsErrors': '\u65e5\u5fd7\u4e0e\u9519\u8bef',
    'agentDetail.output': '\u8f93\u51fa',
    'agentDetail.errors': '\u9519\u8bef',
    'agentDetail.noOutput': '\u6682\u65e0\u8f93\u51fa\u65e5\u5fd7',
    'agentDetail.noErrors': '\u6682\u65e0\u9519\u8bef',
    'agentDetail.failedLogs': '\u52a0\u8f7d\u65e5\u5fd7\u5931\u8d25',
    'createAgent.title': '\u6ce8\u518c\u65b0\u6210\u5458',
    'createAgent.name': '\u540d\u79f0 *',
    'createAgent.namePlaceholder': '\u4f8b\u5982 DevOps',
    'createAgent.role': '\u89d2\u8272',
    'createAgent.rolePlaceholder': '\u4f8b\u5982 \u8fd0\u7ef4\u5de5\u7a0b\u5e08',
    'createAgent.reportsTo': '\u4e0a\u7ea7',
    'createAgent.secret': '\u6ce8\u518c\u5bc6\u94a5',
    'createAgent.secretPlaceholder': '\u4e0d\u9700\u8981\u5219\u7559\u7a7a',
    'createAgent.authConfig': '\u8ba4\u8bc1\u914d\u7f6e',
    'createAgent.cancel': '\u53d6\u6d88',
    'createAgent.register': '\u6ce8\u518c',
    'createAgent.nameRequired': '\u8bf7\u8f93\u5165\u6210\u5458\u540d\u79f0',
    'createAgent.success': '\u6210\u5458\u6ce8\u518c\u6210\u529f\uff01',
    'createAgent.apiKeyLabel': 'API Key',
    'createAgent.saveWarning': '\u8bf7\u4fdd\u5b58\u6b64\u5bc6\u94a5\uff0c\u4e4b\u540e\u65e0\u6cd5\u518d\u6b21\u83b7\u53d6\u3002',
    'createAgent.error': '\u9519\u8bef',
    'files.failed': '\u52a0\u8f7d\u6587\u4ef6\u4e8b\u4ef6\u5931\u8d25',
    'files.empty': '\u6682\u65e0\u6587\u4ef6\u6d3b\u52a8',
    'members.title': '\u6210\u5458',
    'members.selectAgent': '\u9009\u62e9\u6210\u5458...',
    'members.failedLoad': '\u52a0\u8f7d\u6210\u5458\u5931\u8d25',
    'members.failedAdd': '\u6dfb\u52a0\u6210\u5458\u5931\u8d25',
    'members.confirmRemove': '\u786e\u5b9a\u4ece\u6b64\u9891\u9053\u79fb\u9664\uff1f',
    'members.noMembers': '\u672a\u627e\u5230\u6210\u5458',
    'members.failedRemove': '\u79fb\u9664\u6210\u5458\u5931\u8d25',
    'agent.starting': '\u542f\u52a8\u4e2d...',
    'agent.stopping': '\u505c\u6b62\u4e2d...',
    'agent.start': '\u542f\u52a8',
    'agent.stop': '\u505c\u6b62',
    'agent.confirmStop': '\u505c\u6b62\u6210\u5458',
    'agent.startFailed': '\u542f\u52a8\u5931\u8d25',
    'agent.stopFailed': '\u505c\u6b62\u5931\u8d25',
    'agent.failed': '\u5931\u8d25',
    'agent.you': '\u6211',
    'agent.clickDm': '\u70b9\u51fb\u79c1\u804a',
    'agent.self': '(\u6211)',
    'agent.outputTitle': '\u6210\u5458\u8f93\u51fa',
    'agent.noOutput': '\u6682\u65e0\u8f93\u51fa',
    'activity.using': '\u6b63\u5728\u4f7f\u7528',
    'activity.thinking': '\u6b63\u5728\u601d\u8003...',
    'general.updated': '\u5df2\u66f4\u65b0',
    'general.today': '\u4eca\u5929',
    'general.yesterday': '\u6628\u5929',
    'theme.light': '\u6d45\u8272',
    'theme.dark': '\u6df1\u8272',
    'wizard.next': '\u4e0b\u4e00\u6b65',
    'wizard.back': '\u4e0a\u4e00\u6b65',
    'wizard.enter': '\u8fdb\u5165\u63a7\u5236\u53f0',
    'wizard.welcomeTitle': '\u6b22\u8fce\u4f7f\u7528 TeamMCP',
    'wizard.welcomeDesc': '\u51e0\u6b65\u914d\u7f6e\uff0c\u642d\u5efa\u60a8\u7684 AI \u667a\u80fd\u4f53\u534f\u4f5c\u5e73\u53f0\u3002',
    'wizard.configTitle': '\u57fa\u7840\u914d\u7f6e',
    'wizard.configDesc': '\u8bbe\u7f6e\u670d\u52a1\u5668\u53c2\u6570\u3002',
    'wizard.agentsDir': 'Agent \u5de5\u4f5c\u76ee\u5f55',
    'wizard.port': '\u670d\u52a1\u7aef\u53e3',
    'wizard.secret': '\u6ce8\u518c\u5bc6\u94a5\uff08\u53ef\u9009\uff09',
    'wizard.secretPlaceholder': '\u7559\u7a7a\u5219\u5f00\u653e\u6ce8\u518c',
    'wizard.profileTitle': '\u600e\u4e48\u79f0\u547c\u60a8\uff1f',
    'wizard.profileDesc': '\u6ce8\u518c\u60a8\u81ea\u5df1\u4f5c\u4e3a\u56e2\u961f\u8d1f\u8d23\u4eba\u3002',
    'wizard.userName': '\u60a8\u7684\u540d\u79f0',
    'wizard.userRole': '\u60a8\u7684\u89d2\u8272',
    'wizard.userNamePlaceholder': '\u4f8b\u5982 Chairman',
    'wizard.userRolePlaceholder': '\u4f8b\u5982 \u8463\u4e8b\u957f',
    'wizard.defaultUserName': 'Chairman',
    'wizard.defaultUserRole': '\u8463\u4e8b\u957f',
    'wizard.configAgentTitle': '\u521b\u5efa\u5de5\u4f5c Agent',
    'wizard.configAgentDesc': '\u521b\u5efa\u4e00\u4e2a\u5de5\u4f5c Agent \u5e76\u914d\u7f6e\u8ba4\u8bc1\u3002',
    'wizard.agentAuthMode': '\u8ba4\u8bc1\u65b9\u5f0f',
    'wizard.authModeOauth': 'OAuth\uff08\u9ed8\u8ba4\uff09',
    'wizard.authModeApiKey': 'API Key',
    'wizard.apiProvider': 'API \u63d0\u4f9b\u7a0b\u5e8f',
    'wizard.apiBaseUrl': 'API \u57fa\u7840 URL',
    'wizard.apiAuthToken': 'API \u51ed\u8bc1\u4ee4\u724c',
    'wizard.apiModel': '\u6a21\u578b\u540d\u79f0',
    'wizard.agentNameInvalid': '\u540d\u79f0\u5305\u542b\u65e0\u6548\u5b57\u7b26\u3002',
    'wizard.agentTitle': '\u521b\u5efa\u9996\u4e2a Agent',
    'wizard.agentDesc': '\u6ce8\u518c\u7b2c\u4e00\u4e2a Agent\u3002',
    'wizard.agentName': '\u540d\u79f0',
    'wizard.agentRole': '\u89d2\u8272',
    'wizard.agentNamePlaceholder': '\u4f8b\u5982 Chairman',
    'wizard.agentRolePlaceholder': '\u4f8b\u5982 AI Assistant',
    'wizard.defaultAgentName': 'Chairman',
    'wizard.defaultAgentRole': 'AI Assistant',
    'wizard.completeTitle': '\u914d\u7f6e\u5b8c\u6210\uff01',
    'wizard.completeDesc': '\u60a8\u7684\u56e2\u961f\u5df2\u5c31\u7eea\u3002\u8bf7\u4fdd\u5b58\u4e0b\u65b9 API Key\u3002',
    'wizard.tourTitle': '\u63a7\u5236\u53f0\u529f\u80fd\u6982\u89c8',
    'wizard.tourDesc': '\u4ee5\u4e0b\u662f TeamMCP \u63a7\u5236\u53f0\u7684\u6838\u5fc3\u529f\u80fd\u3002',
    'wizard.tourChannels': '\u9891\u9053',
    'wizard.tourChannelsDesc': '\u4e0e AI \u667a\u80fd\u4f53\u5b9e\u65f6\u7fa4\u804a\u548c\u79c1\u804a\u3002',
    'wizard.tourTasks': '\u4efb\u52a1\u7ba1\u7406',
    'wizard.tourTasksDesc': '\u521b\u5efa\u3001\u5206\u914d\u548c\u8ffd\u8e2a\u56e2\u961f\u4efb\u52a1\u3002',
    'wizard.tourAgents': '\u6210\u5458\u7ba1\u7406',
    'wizard.tourAgentsDesc': '\u6ce8\u518c\u3001\u542f\u505c\u548c\u914d\u7f6e\u667a\u80fd\u4f53\uff0c\u67e5\u770b\u7ec4\u7ec7\u67b6\u6784\u3002',
    'wizard.tourState': '\u9879\u76ee\u72b6\u6001',
    'wizard.tourStateDesc': '\u8ffd\u8e2a\u9879\u76ee\u72b6\u6001\u3001\u5ba1\u6279\u6d41\u548c\u5ba1\u8ba1\u62a5\u544a\u3002',
    'wizard.apiKey': 'API Key\uff08\u70b9\u51fb\u590d\u5236\uff09',
    'wizard.nextSteps': '\u4e0b\u4e00\u6b65\uff1a',
    'wizard.stepInstall': '\u8fd0\u884c <code>npm start</code> \u542f\u52a8\u670d\u52a1\u5668',
    'wizard.stepVisit': '\u6253\u5f00 <code>http://localhost:{port}</code>',
    'wizard.stepShare': '\u5c06 API Key \u5206\u4eab\u7ed9\u56e2\u961f\u6210\u5458',
    'wizard.registerFailed': '\u6ce8\u518c\u5931\u8d25\uff1a',
    'wizard.nameRequired': 'Agent \u540d\u79f0\u4e0d\u80fd\u4e3a\u7a7a',
    'wizard.nameInvalid': '\u65e0\u6548\u7684 Agent \u540d\u79f0\uff08\u4ec5\u5b57\u6bcd\u3001\u6570\u5b57\u3001-、_\uff09',
    'wizard.configSaved': '\u914d\u7f6e\u5df2\u4fdd\u5b58\u3002',
    'wizard.skip': '\u8df3\u8fc7',
    'wechat.connected': '\u5df2\u8fde\u63a5',
    'wechat.disconnected': '\u672a\u8fde\u63a5',
    'wechat.scanning': '\u626b\u7801\u4e2d...',
    'wechat.bind': '\u7ed1\u5b9a\u5fae\u4fe1',
    'wechat.disconnect': '\u89e3\u9664\u7ed1\u5b9a',
    'wechat.cancel': '\u53d6\u6d88',
    'wechat.scanHint': '\u8bf7\u7528\u5fae\u4fe1\u626b\u7801\u7ed1\u5b9a',
    'wechat.confirmDisconnect': '\u786e\u8ba4\u89e3\u9664\u5fae\u4fe1\u7ed1\u5b9a\uff1f',
    'wechat.bindFailed': '\u5fae\u4fe1\u7ed1\u5b9a\u5931\u8d25',
    'wechat.disconnectFailed': '\u89e3\u9664\u7ed1\u5b9a\u5931\u8d25',
  },
  t(key) {
    return this[this._lang][key] || this.en[key] || key;
  },
  setLang(lang) {
    this._lang = lang;
    localStorage.setItem('tmcp-lang', lang);
  }
};

function toggleLang() {
  var newLang = i18n._lang === 'en' ? 'zh' : 'en';
  i18n.setLang(newLang);
  document.getElementById('lang-toggle').textContent = newLang === 'en' ? 'EN' : '\u4e2d\u6587';
  applyI18n();
}

function toggleTheme() {
  var current = document.documentElement.getAttribute('data-theme') || 'dark';
  var newTheme = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('tmcp-theme', newTheme);
  document.getElementById('theme-toggle').textContent = newTheme === 'dark' ? '\uD83C\uDF19' : '\u2600\uFE0F';
}

// Apply saved preferences on load
(function() {
  var savedTheme = localStorage.getItem('tmcp-theme') || 'dark';
  if (savedTheme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  }
  // Set initial button states
  var langBtn = document.getElementById('lang-toggle');
  if (langBtn) langBtn.textContent = i18n._lang === 'en' ? 'EN' : '\u4e2d\u6587';
  var themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) themeBtn.textContent = savedTheme === 'dark' ? '\uD83C\uDF19' : '\u2600\uFE0F';
})();

function applyI18n() {
  // Auth
  var authTitle = document.querySelector('.auth-card h1');
  if (authTitle) authTitle.textContent = i18n.t('auth.title');
  var authDesc = document.querySelector('.auth-card p');
  if (authDesc) authDesc.textContent = i18n.t('auth.desc');
  var authInput = document.querySelector('.auth-card input');
  if (authInput) authInput.placeholder = i18n.t('auth.placeholder');
  var authBtn = document.querySelector('.auth-card button');
  if (authBtn) authBtn.textContent = i18n.t('auth.connect');

  // Header
  var headerTitle = document.querySelector('#header h1');
  if (headerTitle) {
    headerTitle.innerHTML = '<span class="logo">T</span> ' + i18n.t('header.title');
  }

  // Sidebar section titles
  var sidebarTitles = document.querySelectorAll('.sidebar-section-title');
  if (sidebarTitles[0]) sidebarTitles[0].textContent = i18n.t('nav.channels');
  if (sidebarTitles[1]) sidebarTitles[1].textContent = i18n.t('nav.tasks');
  if (sidebarTitles[2]) sidebarTitles[2].textContent = i18n.t('nav.state');

  // Sidebar nav items
  var tasksNavName = document.querySelector('#tasks-nav .channel-name');
  if (tasksNavName) tasksNavName.textContent = i18n.t('nav.allTasks');
  var stateNavName = document.querySelector('#state-nav .channel-name');
  if (stateNavName) stateNavName.textContent = i18n.t('nav.projectState');
  var agentsNavName = document.querySelector('#agents-nav .channel-name');
  if (agentsNavName) agentsNavName.textContent = i18n.t('nav.agentMgmt');

  // SSE label
  var sseLabel = document.getElementById('sse-label');
  if (sseLabel) {
    var sseText = sseLabel.textContent;
    if (sseText === 'Connected' || sseText === '\u5df2\u8fde\u63a5') sseLabel.textContent = i18n.t('sse.connected');
    else if (sseText === 'Disconnected' || sseText === '\u672a\u8fde\u63a5') sseLabel.textContent = i18n.t('sse.disconnected');
    else if (sseText === 'Reconnecting...' || sseText === '\u91cd\u8fde\u4e2d...') sseLabel.textContent = i18n.t('sse.reconnecting');
  }

  // Compose
  var composeInput = document.querySelector('#compose textarea');
  if (composeInput) composeInput.placeholder = i18n.t('compose.placeholder');
  var sendBtn = document.querySelector('#compose .send-btn');
  if (sendBtn) sendBtn.textContent = i18n.t('compose.send');
  var composeHint = document.querySelector('.compose-hint');
  if (composeHint) composeHint.textContent = i18n.t('compose.hint');

  // Task filters
  var filterStatus = document.getElementById('filter-status');
  if (filterStatus && filterStatus.options.length >= 4) {
    filterStatus.options[0].text = i18n.t('tasks.allStatus');
    filterStatus.options[1].text = i18n.t('tasks.todo');
    filterStatus.options[2].text = i18n.t('tasks.doing');
    filterStatus.options[3].text = i18n.t('tasks.done');
  }

  // Tasks header
  var tasksH2 = document.querySelector('#tasks-header h2');
  if (tasksH2) tasksH2.innerHTML = '&#128203; ' + i18n.t('tasks.title');

  // New task button
  var newTaskBtn = document.getElementById('new-task-btn');
  if (newTaskBtn) newTaskBtn.textContent = i18n.t('tasks.newTask');

  // State header
  var stateH2 = document.querySelector('#state-header h2');
  if (stateH2) stateH2.innerHTML = '&#128202; ' + i18n.t('state.title');

  // Agents header
  var agentsH2 = document.querySelector('#agents-header h2');
  if (agentsH2) agentsH2.innerHTML = '&#9881; ' + i18n.t('agents.title');
  var newAgentBtn = document.getElementById('new-agent-btn');
  if (newAgentBtn) newAgentBtn.textContent = i18n.t('agents.newAgent');

  // Task detail header
  var taskDetailH3 = document.querySelector('#task-detail .detail-header h3');
  if (taskDetailH3) taskDetailH3.textContent = i18n.t('taskDetail.title');

  // Agent detail header
  var agentDetailH3 = document.querySelector('#agent-detail .detail-header h3');
  if (agentDetailH3) agentDetailH3.textContent = i18n.t('agentDetail.title');

  // State field detail header
  var stateDetailH3 = document.querySelector('#state-field-detail h3');
  if (stateDetailH3) stateDetailH3.textContent = i18n.t('state.fieldDetail');

  // Pin bar text
  var pinCount = document.getElementById('pin-count');
  if (pinCount) {
    var pinBarSpan = pinCount.parentElement;
    if (pinBarSpan) pinBarSpan.innerHTML = '<span class="pin-count" id="pin-count">' + (pinCount.textContent || '0') + '</span> ' + i18n.t('channel.pinnedMessages');
  }

  // Lang toggle button text (header + wizard)
  var langLabel = i18n._lang === 'en' ? 'EN' : '\u4e2d\u6587';
  var langBtn = document.getElementById('lang-toggle');
  if (langBtn) langBtn.textContent = langLabel;
  var wizLangBtn = document.getElementById('wizard-lang-toggle');
  if (wizLangBtn) wizLangBtn.textContent = langLabel;

  // Theme toggle (header + wizard)
  var curTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  var themeLabel = curTheme === 'dark' ? '\uD83C\uDF19' : '\u2600\uFE0F';
  var themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) themeBtn.textContent = themeLabel;
  var wizThemeBtn = document.getElementById('wizard-theme-toggle');
  if (wizThemeBtn) wizThemeBtn.textContent = themeLabel;

  // Re-render dynamic content if in view
  if (typeof renderAgents === 'function') renderAgents();
}
