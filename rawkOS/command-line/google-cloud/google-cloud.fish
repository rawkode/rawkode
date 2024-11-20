set -gx CLOUDSDK_ROOT_DIR /opt/google-cloud-cli
set -gx CLOUDSDK_PYTHON /usr/bin/python
set -gx CLOUDSDK_PYTHON_ARGS '-S -W ignore'
set -gx GOOGLE_CLOUD_SDK_HOME $CLOUDSDK_ROOT_DIR

fish_add_path $CLOUDSDK_ROOT_DIR/bin
