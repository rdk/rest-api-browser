// **processWADL** will blow through a WADL file (specified by URL) and normalize
// it for consumption. The output is in JSON. This code is hosted at
// <https://bitbucket.org/rmanalan/process-wadl>
//
// ####Sample call:
//
//     processWADL('/rest/api/1.0/application.wadl')
//       .done(function(d) {
//         // success
//       })
//       .fail(function(d) {
//         // error
//       });
//
function processWADL(resource) {
    var debug = false,
        useNamespace = false,
    // Turn this function to a jQuery promise object
        dfd = new jQuery.Deferred();

    var slugify = function(str) {
        return str.toLowerCase().replace(/[^-a-zA-Z0-9,&\s]+/ig, '-').replace(/\s/gi, "-").replace(/^-/, '').replace(/-$/, '');
    };


    resource.relativeResource = resource.path.split('/').slice(-2).join('/');
    var rootResource = resource;

    function addNamespace(selector){
        if (!useNamespace) return selector;
        return "ns2\\:" + selector;
    }

    // Use jQuery ajax to get WADL from a URL
    jQuery.ajax({
        url:resource.wadl,
        dataType:"text xml"
    }).error(function() {
            // Reject the promise if there's an ajax error
            dfd.reject({
                error: "Something shitty happened. Sorry."
            });
        }).success(function(x) {
            // Ajax call was successful
            var outResources = [];

            // Test to see if namespace is required
            var resources = jQuery(x).find('resources');
            var top;
            if (resources.length === 0) {
                useNamespace = true;
                resources = jQuery(x).find(addNamespace('resources'));
            } else {
                top = resources.find('>'+addNamespace('resource'));
                if (top.length === 0) {
                    useNamespace = true;
                    top = resources.find('>'+addNamespace('resource'));
                }
            }

            var base = resources.attr('base');

            // Helper function for extracting the doc CDATA section from
            // a node
            function getDoc(node,html) {

                var txt,
                    html = html || false,
                    doc = node.find('>'+addNamespace('doc'));
                if (doc.length > 0) {
                    if (html) {
                        try {
                            txt = doc.contents()[0].nextSibling.innerHTML.replace(/<(\/?)([^:>]*:)?([^>]+)>/g, "<$1$3>");
                        } catch(e){
                            txt = doc.text();
                        }
                    } else {
                        txt = doc.text();
                    }
                }
                return txt || "";
            }

            function getCode(node, mediaType) {
                var $doc = node.find('>' + addNamespace('doc')),
                    $code = $doc.find('>ns3\\:p, >p').find('>ns3\\:pre, >pre').find('>ns3\\:code, >code'),
                    text = $code.text();
                if (mediaType === 'application/json') {
                    try {
                        text = JSON.stringify(JSON.parse(text), null, 2);
                    } catch (e) {}
                }
                return text;
            }

            // Main function to cycle through resources in the WADL. This
            // function is called recursively.
            function getResource(resource, path, resourceWideParams, obj) {
                var childResource, methodArry, path, params, methods,
                    outMethods = [], addlPath = resource.attr('path');

                obj = obj || {};

                // Replace brackets with colon
                // addlPath = addlPath.replace(/\{/g,":").replace(/\}/g,"");

                // Check for forward slashes before concatinating
                if (/\/jQuery/g.test(path) || /^\//g.test(addlPath)) {
                    path += addlPath;
                } else {
                    path += '/' + addlPath;
                }
                path = path.replace(/\/\//g,'/');
                obj.name = [rootResource.relativeResource,path].join('');
                obj.url = [rootResource.path,path].join('');
                obj.key = slugify(obj.name);
                obj.description = getDoc(resource);

                // Extract resource-wide params that live inside the path
                params = resource.find('>'+addNamespace('param'));
                if (params.length > 0) {
                    // Reset resource-wide params if no template params in uri
                    if (/\{/g.test(path)) {
                        resourceWideParams = [];
                    }
                    // Cycle through all resource-wide params
                    jQuery.each(params, function() {
                        var param = {},
                            self = jQuery(this);
                        param.name = self.attr('name');
                        param.description = getDoc(self);
                        param.type = self.attr('type').split(':')[1];
                        param.style = self.attr('style');
                        resourceWideParams.push(param);
                    });
                }

                // Look for methods inside resources
                methods = resource.find('>'+addNamespace('method'));
                if (methods.length > 0) {
                    // Methods found inside the resource. Extract them
                    jQuery.each(methods, function() {
                        var methodObj = {},
                            params, request, response, self = jQuery(this);

                        methodObj.params = [];
                        methodObj.method = self.attr('name');
                        methodObj.description = getDoc(self);
                        methodObj.uri = path;
                        methodObj.representations = {requests: [], responses: []};

                        // Look for params inside methods. If found
                        // extract them
                        request = self.find('>'+addNamespace('request'));
                        if (request.length > 0) {
                            // Merge resource-wide params with method params
                            jQuery.merge(methodObj.params, resourceWideParams);
                            params = request.find('>'+addNamespace('param'));
                            jQuery.each(params, function() {
                                var param = {},
                                    self = jQuery(this);
                                param.name = self.attr('name');
                                param.description = getDoc(self);
                                param.type = self.attr('type').split(':')[1];
                                param.style = self.attr('style');
                                methodObj.params.push(param);
                            });
                            methodObj.representations.requests = jQuery.map(request.find('>'+addNamespace('representation')), function(n) {
                                var param = {};
                                var self = jQuery(n);
                                param.mediaType = self.attr('mediaType')
                                param.example = getCode(self, param.mediaType);
                                param.doc = getDoc(self,true);
                                return param;
                            });
                        } else {
                            methodObj.params = resourceWideParams;
                        }

                        response = self.find('>'+addNamespace('response'));
                        if (response.length > 0){
                            methodObj.representations.responses = jQuery.map(response.find('>'+addNamespace('representation')), function(n){
                                var param = {};
                                var self = jQuery(n);
                                param.mediaType = self.attr('mediaType');
                                param.status = self.attr('status');
                                param.example = getCode(self, param.mediaType);
                                param.doc = getDoc(self,true);
                                return param;
                            });
                        }

                        outMethods.push(methodObj);
                    });

                    // Loop through additional child resources
                    childResource = resource.find('>'+addNamespace('resource'));
                    jQuery.each(childResource, function() {
                        var self = jQuery(this);
                        getResource(self, path, resourceWideParams);
                    });

                    // Attach methods inside of resource object
                    obj.methods = outMethods;

                    // Append to master resource array
                    outResources.push(obj);

                    if (debug) {
                        // Debug messages
                        methodsArry = jQuery.map(methods, function(i, e) {
                            return jQuery(i).attr('name')
                        });
                        methodsArry.length === 0 || console.log(path, methodsArry, obj, resource[0]);
                    }

                } else {
                    // No methods found inside this resource.
                    // Loop through additional child resources
                    childResource = resource.find('>'+addNamespace('resource'));
                    jQuery.each(childResource, function() {
                        var self = jQuery(this);
                        getResource(self, path, resourceWideParams);
                    });
                }

            }

            // Loop through the top level resources
            jQuery.each(top, function() {
                var self = jQuery(this);
                getResource(self, '', []);
            });

            // Resolve the promise with the resources found
            dfd.resolve({
                ns: resource,
                resources: outResources.sort(function(x,y){return (x.name < y.name)? -1: 1})
            });

        });

    // Return the promise object
    return dfd.promise();
}

