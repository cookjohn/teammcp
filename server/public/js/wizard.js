var wizardStep = 1;
var wizardData = {};

function showSetupWizard() {
  var el = document.getElementById('setup-wizard');
  if (!el) return;
  el.classList.add('active');
  wizardStep = 1;
  wizardData = {};
  renderWizardStep();
}

function hideSetupWizard() {
  var el = document.getElementById('setup-wizard');
  if (!el) return;
  el.classList.remove('active');
}

function renderWizardStep() {
  document.querySelectorAll('.wizard-step').forEach(function(el) {
    var step = parseInt(el.dataset.step);
    el.classList.remove('active', 'done');
    if (step === wizardStep) el.classList.add('active');
    else if (step < wizardStep) el.classList.add('done');
  });

  var backBtn = document.getElementById('wizard-back');
  var nextLabel = document.getElementById('wizard-next');
  var skipBtn = document.getElementById('wizard-skip');

  backBtn.textContent = wizardStep === 1 ? '' : i18n.t('wizard.back');
  nextLabel.textContent = wizardStep === 6 ? i18n.t('wizard.enter') : i18n.t('wizard.next');
  skipBtn.style.display = (wizardStep === 2 || wizardStep === 3 || wizardStep === 4) ? '' : 'none';

  var errEl = document.getElementById('wizard-error');
  if (errEl) errEl.textContent = '';

  var content = document.getElementById('wizard-content');
  switch (wizardStep) {
    case 1: renderWizardWelcome(content); break;
    case 2: renderWizardConfig(content); break;
    case 3: renderWizardProfile(content); break;
    case 4: renderWizardConfigureAgent(content); break;
    case 5: renderWizardComplete(content); break;
    case 6: renderWizardTour(content); break;
  }
}

function wizardBack() { if (wizardStep > 1) { wizardStep--; renderWizardStep(); } }

function wizardSkip() {
  if (wizardStep === 2 || wizardStep === 3 || wizardStep === 4) { wizardStep = 5; renderWizardStep(); }
}

async function wizardNext() {
  var errEl = document.getElementById('wizard-error');
  if (errEl) errEl.textContent = '';

  if (wizardStep === 2) {
    var agentsDir = document.getElementById('wiz-agents-dir');
    var port = document.getElementById('wiz-port');
    var secret = document.getElementById('wiz-secret');
    wizardData.agentsDir = agentsDir ? agentsDir.value : '';
    wizardData.port = port ? port.value : '3100';
    wizardData.secret = secret ? secret.value : '';
  }

  // Step 3: Register user themselves (Chairman)
  if (wizardStep === 3) {
    var nameInput = document.getElementById('wiz-user-name');
    var name = nameInput ? nameInput.value.trim() : '';
    var roleInput = document.getElementById('wiz-user-role');
    var role = roleInput ? roleInput.value.trim() : '';

    if (!name) {
      if (errEl) errEl.textContent = i18n.t('wizard.nameRequired');
      return;
    }
    if (!/^[A-Za-z0-9_\-]+$/.test(name)) {
      if (errEl) errEl.textContent = i18n.t('wizard.nameInvalid');
      return;
    }

    var registerBody = { name: name };
    if (role) registerBody.role = role;
    if (wizardData.secret) registerBody.secret = wizardData.secret;

    try {
      var res = await fetch('/api/register', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(registerBody)
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');
      wizardData.apiKey = data.apiKey || data.data?.apiKey || '';
    } catch (e) {
      if (errEl) errEl.textContent = i18n.t('wizard.registerFailed') + e.message;
      return;
    }
  }

  // Step 4: Create a working agent with auth config
  if (wizardStep === 4) {
    var agentNameInput = document.getElementById('wiz-agent-name');
    var aName = agentNameInput ? agentNameInput.value.trim() : '';
    var agentRoleInput = document.getElementById('wiz-agent-role');
    var aRole = agentRoleInput ? agentRoleInput.value.trim() : '';
    var agentAuthMode = document.getElementById('wiz-agent-auth-mode');
    var aAuthMode = agentAuthMode ? agentAuthMode.value : null;

    // Only create if user provided a non-empty name
    if (aName) {
      if (!/^[A-Za-z0-9_.\-]+$/.test(aName)) {
        if (errEl) errEl.textContent = i18n.t('wizard.agentNameInvalid');
        return;
      }
      var agentRegisterBody = { name: aName };
      if (aRole) agentRegisterBody.role = aRole;
      if (wizardData.secret) agentRegisterBody.secret = wizardData.secret;

      try {
        var agentRes = await fetch('/api/register', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(agentRegisterBody)
        });
        var agentData = await agentRes.json();
        if (!agentRes.ok) throw new Error(agentData.error || 'Agent registration failed');
        wizardData.agentName = aName;
      } catch (e) {
        if (errEl) errEl.textContent = i18n.t('wizard.registerFailed') + e.message;
        return;
      }

      // Save auth config if provided
      if (aAuthMode) {
        var patchBody = { auth_mode: aAuthMode };
        if (aAuthMode === 'api_key') {
          var provider = document.getElementById('wiz-agent-api-provider');
          var baseUrl = document.getElementById('wiz-agent-api-base-url');
          var apiToken = document.getElementById('wiz-agent-api-token');
          var apiModel = document.getElementById('wiz-agent-api-model');
          if (provider && provider.value) patchBody.api_provider = provider.value;
          if (baseUrl && baseUrl.value) patchBody.api_base_url = baseUrl.value;
          if (apiToken && apiToken.value) patchBody.api_auth_token = apiToken.value;
          if (apiModel && apiModel.value) patchBody.api_model = apiModel.value;
        }
        try {
          await fetch('/api/agents/' + encodeURIComponent(aName), {
            method: 'PATCH',
            headers: { 'Authorization': 'Bearer ' + (wizardData.apiKey || API_KEY), 'Content-Type': 'application/json' },
            body: JSON.stringify(patchBody)
          });
        } catch (e) {
          // Non-critical: agent is registered, config can be set later
        }
      }
    }
  }

  // Step 5: Complete — authenticate and prepare dashboard
  if (wizardStep === 5 && wizardData.apiKey) {
    try {
      API_KEY = wizardData.apiKey;
      localStorage.setItem('teammcp_key', API_KEY);
      var agentsData = await api('/api/agents');
      agents = agentsData;
      var chData = await api('/api/channels');
      channels = chData;
      agentName = await resolveAgentName();
      renderAgents();
      renderChannels();
      document.getElementById('auth-overlay').style.display = 'none';
      document.getElementById('app').classList.add('active');
    } catch (e) {
      localStorage.setItem('teammcp_key', wizardData.apiKey);
      location.reload();
      return;
    }
  }

  if (wizardStep === 6) {
    hideSetupWizard();
    init();
    return;
  }

  wizardStep++;
  renderWizardStep();
}

function renderWizardWelcome(container) {
  container.innerHTML =
    '<div class="wizard-emoji">\uD83D\uDE80</div>' +
    '<h2>' + i18n.t('wizard.welcomeTitle') + '</h2>' +
    '<p class="wizard-desc">' + i18n.t('wizard.welcomeDesc') + '</p>';
}

function renderWizardConfig(container) {
  container.innerHTML =
    '<h2>' + i18n.t('wizard.configTitle') + '</h2>' +
    '<p class="wizard-desc">' + i18n.t('wizard.configDesc') + '</p>' +
    '<div class="form-group">' +
      '<label>' + i18n.t('wizard.agentsDir') + '</label>' +
      '<input type="text" id="wiz-agents-dir" value="' + escapeHtml(getDefaultAgentsDir()) + '" placeholder="~/teammcp-agents">' +
    '</div>' +
    '<div class="form-group">' +
      '<label>' + i18n.t('wizard.port') + '</label>' +
      '<input type="text" id="wiz-port" value="' + encodeURIComponent(window.location.port || '3100') + '" placeholder="3100">' +
    '</div>' +
    '<div class="form-group">' +
      '<label>' + i18n.t('wizard.secret') + '</label>' +
      '<input type="password" id="wiz-secret" placeholder="' + i18n.t('wizard.secretPlaceholder').replace(/"/g, '&quot;') + '">' +
    '</div>';
}

function renderWizardProfile(container) {
  container.innerHTML =
    '<h2>' + i18n.t('wizard.profileTitle') + '</h2>' +
    '<p class="wizard-desc">' + i18n.t('wizard.profileDesc') + '</p>' +
    '<div class="form-group">' +
      '<label>' + i18n.t('wizard.userName') + '</label>' +
      '<input type="text" id="wiz-user-name" value="' + i18n.t('wizard.defaultUserName') + '" placeholder="' + i18n.t('wizard.userNamePlaceholder').replace(/"/g, '&quot;') + '">' +
    '</div>' +
    '<div class="form-group">' +
      '<label>' + i18n.t('wizard.userRole') + '</label>' +
      '<input type="text" id="wiz-user-role" value="' + i18n.t('wizard.defaultUserRole') + '" placeholder="' + i18n.t('wizard.userRolePlaceholder').replace(/"/g, '&quot;') + '">' +
    '</div>';
}

function renderWizardConfigureAgent(container) {
  container.innerHTML =
    '<h2>' + i18n.t('wizard.configAgentTitle') + '</h2>' +
    '<p class="wizard-desc">' + i18n.t('wizard.configAgentDesc') + '</p>' +
    '<div class="form-group">' +
      '<label>' + i18n.t('wizard.agentName') + '</label>' +
      '<input type="text" id="wiz-agent-name" value="' + i18n.t('wizard.defaultAgentName') + '" placeholder="' + i18n.t('wizard.agentNamePlaceholder').replace(/"/g, '&quot;') + '">' +
    '</div>' +
    '<div class="form-group">' +
      '<label>' + i18n.t('wizard.agentRole') + '</label>' +
      '<input type="text" id="wiz-agent-role" value="' + i18n.t('wizard.defaultAgentRole') + '" placeholder="' + i18n.t('wizard.agentRolePlaceholder').replace(/"/g, '&quot;') + '">' +
    '</div>' +
    '<div class="form-group">' +
      '<label>' + i18n.t('wizard.agentAuthMode') + '</label>' +
      '<select id="wiz-agent-auth-mode" onchange="toggleWizardAuthFields()">' +
        '<option value="oauth">' + i18n.t('wizard.authModeOauth') + '</option>' +
        '<option value="api_key">' + i18n.t('wizard.authModeApiKey') + '</option>' +
      '</select>' +
    '</div>' +
    '<div id="wiz-agent-apikey-fields" style="display:none;">' +
      '<div class="form-group">' +
        '<label>' + i18n.t('wizard.apiProvider') + '</label>' +
        '<select id="wiz-agent-api-provider">' +
          '<option value="">Select...</option>' +
          '<option value="anthropic">Anthropic</option>' +
          '<option value="openai">OpenAI</option>' +
          '<option value="openrouter">OpenRouter</option>' +
          '<option value="custom">Custom</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>' + i18n.t('wizard.apiBaseUrl') + '</label>' +
        '<input type="text" id="wiz-agent-api-base-url" placeholder="https://api.openai.com/v1">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>' + i18n.t('wizard.apiAuthToken') + '</label>' +
        '<input type="password" id="wiz-agent-api-token" placeholder="sk-...">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>' + i18n.t('wizard.apiModel') + '</label>' +
        '<input type="text" id="wiz-agent-api-model" placeholder="gpt-4o">' +
      '</div>' +
    '</div>';
}

function renderWizardComplete(container) {
  var apiKey = wizardData.apiKey || 'tmcp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  var port = window.location.port || wizardData.port || '3100';
  container.innerHTML =
    '<div class="wizard-emoji">\u2705</div>' +
    '<h2>' + i18n.t('wizard.completeTitle') + '</h2>' +
    '<p class="wizard-desc">' + i18n.t('wizard.completeDesc') + '</p>' +
    '<div class="wizard-api-key-box" onclick="navigator.clipboard.writeText(this.textContent).catch(function(){})" title="' + i18n.t('wizard.apiKey') + '">' + escapeHtml(apiKey) + '</div>' +
    '<ul class="wizard-next-steps">' +
      '<li>' + i18n.t('wizard.stepInstall') + '</li>' +
      '<li>' + i18n.t('wizard.stepVisit').replace('{port}', escapeHtml(port)) + '</li>' +
      '<li>' + i18n.t('wizard.stepShare') + '</li>' +
    '</ul>';
}

function toggleWizardAuthFields() {
  var modeEl = document.getElementById('wiz-agent-auth-mode');
  var fieldsEl = document.getElementById('wiz-agent-apikey-fields');
  if (modeEl && fieldsEl) {
    fieldsEl.style.display = modeEl.value === 'api_key' ? 'block' : 'none';
  }
}

function getDefaultAgentsDir() {
  return '~/teammcp-agents';
}

function renderWizardTour(container) {
  container.innerHTML =
    '<h2>' + i18n.t('wizard.tourTitle') + '</h2>' +
    '<p class="wizard-desc">' + i18n.t('wizard.tourDesc') + '</p>' +
    '<div class="tour-grid">' +
      '<div class="tour-card">' +
        '<div class="tour-card-icon">\uD83D\uDCAC</div>' +
        '<div class="tour-card-title">' + i18n.t('wizard.tourChannels') + '</div>' +
        '<div class="tour-card-desc">' + i18n.t('wizard.tourChannelsDesc') + '</div>' +
      '</div>' +
      '<div class="tour-card">' +
        '<div class="tour-card-icon">\uD83D\uDCCB</div>' +
        '<div class="tour-card-title">' + i18n.t('wizard.tourTasks') + '</div>' +
        '<div class="tour-card-desc">' + i18n.t('wizard.tourTasksDesc') + '</div>' +
      '</div>' +
      '<div class="tour-card">' +
        '<div class="tour-card-icon">\u2699\uFE0F</div>' +
        '<div class="tour-card-title">' + i18n.t('wizard.tourAgents') + '</div>' +
        '<div class="tour-card-desc">' + i18n.t('wizard.tourAgentsDesc') + '</div>' +
      '</div>' +
      '<div class="tour-card">' +
        '<div class="tour-card-icon">\uD83D\uDCCA</div>' +
        '<div class="tour-card-title">' + i18n.t('wizard.tourState') + '</div>' +
        '<div class="tour-card-desc">' + i18n.t('wizard.tourStateDesc') + '</div>' +
      '</div>' +
    '</div>';
}
