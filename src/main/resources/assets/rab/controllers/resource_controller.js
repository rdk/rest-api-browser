'use strict';

angular.module('RAB')
    .controller('ResourceCtrl', ['$scope', '$rootScope', '$routeParams', 'restResources',
        function ($scope,$rootScope,$routeParams,restResources) {

            $scope.$on('$viewContentLoaded', function(){
                AJS.$('.rab-scope').tooltip();

                // Inline dialog for cURL... disabled for now
                /*
                AJS.InlineDialog(AJS.$("#rab-curl"), 1,
                    function(content, trigger, showPopup) {
                        content
                            .css({"padding":"20px"})
                            .html('<h2>Inline dialog</h2><p>The inline dialog is a wrapper for secondary content/controls to be displayed on user request. Consider this component as displayed in context to the triggering control with the dialog overlaying the page content.</p><button class="aui-button">Done</button></form>');
                        showPopup();
                        return false;
                    }
                );
                */
            });

            // Custom method name sorting routine for tabs
            function methodNameValue(method){
                if (method.method === 'GET')     return 0;
                if (method.method === 'POST')    return 1;
                if (method.method === 'PUT')     return 2;
                if (method.method === 'PATCH')   return 3;
                if (method.method === 'HEAD')    return 4;
                if (method.method === 'OPTIONS') return 5;
                if (method.method === 'DELETE')  return 6;
            }

            function SendRequestError(msg){
                AJS.messages.error('#rab-errors',
                    {
                        title: 'Send request error',
                        body: msg
                    }
                );
            }

            // Listen for selected resource off of the $rootScope... pretty hacky.
            // The alternative is to call the resource loader again and search through
            // the resources array. This is probably more efficient since I'm
            // just passing the selected resource from the sidebarCtrl.
            var method = {};
            if(!$rootScope.selectedResourceWatchSet) {
                $rootScope.$watch('selectedResource', function(newVal, oldVal){
                    $rootScope.selectedResourceWatchSet = true;
                    if(!newVal) return;
                    $rootScope.resource = newVal;
                    $rootScope.resource.methods = _.sortBy($rootScope.resource.methods,methodNameValue);
                    if($routeParams.method){
                        method = _.where($rootScope.resource.methods, {method: $routeParams.method})[0];
                    } else {
                        method = $rootScope.resource.methods[0];
                    }
                    try {
                        if (method.reqRep === undefined) method.reqRep = method.representations.requests[0].mediaType;
                        if (method.reqBody === undefined) method.reqBody = method.representations.requests[0].example;
                    } catch(e){}
                });
            } else if ($rootScope.resource && $rootScope.resource.methods) {
                if($routeParams.method){
                    method = _.where($rootScope.resource.methods, {method: $routeParams.method})[0];
                } else {
                    method = $rootScope.resource.methods[0];
                }
                if (method) {
                    try {
                        if (method.reqRep === undefined) method.reqRep = method.representations.requests[0].mediaType;
                        if (method.reqBody === undefined) method.reqBody = method.representations.requests[0].example;
                    } catch(e){}
                }
            }

            $scope.reqEditorOptions = {
                mode:'javascript',
                theme:'neat',
                lineNumbers:true,
                foldGutter:true,
                gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
                indentWithTabs:false,
                electricChars:true,
                matchBrackets:true,
                autoCloseBrackets:true,
                highlightSelectionMatches:true,
                indentUnit:2,
                // styleActiveLine: true,
                extraKeys: {'Tab': 'indentMore', 'Shift-Tab': 'indentLess'}
            };

            $scope.respEditorOptions = {
                mode:'javascript',
                theme:'neat',
                lineNumbers:true,
                indentUnit:2,
                foldGutter:true,
                gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
                readOnly:true,
                highlightSelectionMatches:true,
                lineWrapping:true
            };

            $scope.addCustomParam = function(method){
                method.customParams = method.customParams ? method.customParams : [];
                method.customParams.push({});
            };

            $scope.removeCustomParam = function(idx, method){
                method.customParams.splice(idx,1);
            };

            $scope.isJsonRPC = function(){
                if($rootScope.resource && /^json\-rpc/i.test($rootScope.resource.name)) {
                    return true;
                }
            };

            $scope.isActive = function(idx){
                if($routeParams.method) {
                    return this.method.method === $routeParams.method;
                } else {
                    return idx === 0 ? true: false;
                }
            };

            $scope.selectUrl = function(evt){
                jQuery(evt.target).select().one('blur', function(){
                    $scope.$apply(function(){
                        $scope.mode = '';
                    });
                });
            };

            $scope.clearResults = function(){
                this.method.response = null;
            };

            $scope.send = function(method){
                jQuery('#rab-errors').html('');
                var url, queryParams, contentType, data;

                url = $rootScope.resource.url;
                var tmplVars = _.where(method.params || [], {style:'template'});
                for (var i = 0; i < tmplVars.length; i++) {
                    var tmplVar = tmplVars[i];
                    if(tmplVar.value === undefined || tmplVar.value === null || tmplVar.value === '') {
                        var safeBody = jQuery('<div>')
                            .text('You forgot to provide a value for the following required parameter: ')
                            .append(jQuery('<b>').text(tmplVar.name))
                            .html();
                        SendRequestError(safeBody);
                        return;
                    }
                    var escapedName = tmplVar.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    var pat = new RegExp('\\{' + escapedName + '(?::[^}]*)?\\}', 'g');
                    // encode the value, but keep its slashes: a template such as {path:.+} spans several segments.
                    // A function as replacement, so that "$&" or "$1" in a value stays literal.
                    var encoded = _.map(String(tmplVar.value).split('/'), encodeURIComponent).join('/');
                    url = url.replace(pat, function() { return encoded; });
                }

                queryParams = _.chain(_.compact((method.params || []).concat(method.customParams || [])))
                    .filter(function(o){
                        return o.style !== 'template';
                    })
                    .map(function(o){
                        if(o.name && String(o.name).trim() && o.value !== undefined && o.value !== null && o.value !== '') {
                            return encodeURIComponent(o.name)+'='+encodeURIComponent(o.value);
                        }
                    })
                    .compact()
                    .join('&')
                    .value();

                if (queryParams.length > 0) {
                    url += '?' + queryParams;
                }

                if (/^(POST|PUT|PATCH|DELETE)$/i.test(method.method) && method.reqBody) {
                    data = method.reqBody.trim();
                }

                if (!method.reqRep) {
                    contentType = 'application/json';
                } else {
                    contentType = method.reqRep;
                }

                jQuery.ajax({
                    url: url,
                    type: method.method,
                    data: data,
                    contentType: contentType,
                    dataType: 'text',
                    headers: !/^(GET|HEAD|OPTIONS)$/i.test(method.method) ? { 'X-Atlassian-Token': 'no-check' } : {},
                    beforeSend: function(){
                        method.sendInProgress = true;
                    },
                    complete: function(){
                        $scope.$apply(function(){
                            method.sendInProgress = false;
                        });
                    }
                }).done(function(d, msg, o){
                    $scope.$apply(function(){
                        var respType, rawBody;
                        method.response = {};
                        method.response.headers = o.getAllResponseHeaders();
                        respType = o.getResponseHeader('Content-Type') || '';
                        rawBody = o.responseText != null ? o.responseText : (d || '');
                        if (!/^application\/xml/.test(respType) && (/json/i.test(respType) || /^\s*[\[{]/.test(rawBody))) {
                            try {
                                method.response.body = JSON.stringify(JSON.parse(rawBody), null, 2);
                            } catch(e) {
                                method.response.body = rawBody;
                            }
                        } else {
                            method.response.body = rawBody;
                        }
                        if (method.response.body == null) method.response.body = '';
                        method.response.status = 'success';
                        method.response.call = url + ' (' + o.status + ')';
                    });
                }).fail(function(o) {
                    $scope.$apply(function(){
                        method.response = {};
                        method.response.headers = o.getAllResponseHeaders();
                        try {
                            method.response.body = JSON.stringify(JSON.parse(o.responseText), null, 2);
                        } catch(e) {
                            method.response.body = o.responseText;
                        }
                        if (method.response.body == null) method.response.body = '';
                        method.response.status = 'error';
                        method.response.call = url + ' (' + o.status + ')';
                    });
                });
            };
        }]
    );