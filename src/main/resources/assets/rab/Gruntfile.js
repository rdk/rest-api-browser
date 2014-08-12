module.exports = function(grunt) {

  // Project configuration.
  grunt.initConfig({
    uglify: {
      options: {
        mangle: false
      },
      build: {
        files: {
          'rest-api-browser.min.js': [
             'vendor/html4-defs.js'
            ,'vendor/uri.js'
            ,'vendor/angular.min.js'
            ,'vendor/angular-route.min.js'
            ,'vendor/angular-sanitize.min.js'
            ,'vendor/codemirror-3.15/lib/codemirror-compressed.js'
            ,'vendor/codemirror-3.15/addon/fold/foldcode.js'
            ,'vendor/codemirror-3.15/addon/fold/foldgutter.js'
            ,'vendor/codemirror-3.15/addon/fold/brace-fold.js'
            ,'vendor/codemirror-3.15/addon/fold/xml-fold.js'
            ,'vendor/codemirror-3.15/addon/edit/matchbrackets.js'
            ,'vendor/codemirror-3.15/addon/edit/closebrackets.js'
            ,'vendor/codemirror-3.15/addon/dialog/dialog.js'
            ,'vendor/codemirror-3.15/addon/search/searchcursor.js'
            ,'vendor/codemirror-3.15/addon/search/search.js'
            ,'vendor/codemirror-3.15/addon/search/match-highlighter.js'
            ,'vendor/ui-utils/modules/unique/unique.js'
            ,'vendor/ui-codemirror.min.js'
            ,'process-wadl.js'
            ,'app.js'
            ,'services/rest_resources_service.js'
            ,'controllers/sidebar_controller.js'
            ,'controllers/main_controller.js'
            ,'controllers/resource_controller.js'
          ]
        }
      }
    }
  });

  // Load the plugin that provides the "uglify" task.
  grunt.loadNpmTasks('grunt-contrib-uglify');

  // Default task(s).
  grunt.registerTask('default', ['uglify']);

};